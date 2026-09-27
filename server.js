const express = require('express');
const { filterEvents, CATEGORY_LABELS } = require('./events');
const { parseQueryToFilters, explainMatch } = require('./llm');
const { sendMessage, miniAppButton } = require('./maxApi');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEFAULT_CITY = process.env.DEFAULT_CITY || 'Казань';
const BALANCE_RESET = 5000; // roubles/year, per Пушкинская карта rules
const REMINDER_DAYS_BEFORE = 45;

// In-memory per-user state — fine for an MVP/demo; swap for a real store
// (Redis/Postgres) before any production use.
const users = new Map();

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      step: 'new',
      city: DEFAULT_CITY,
      interests: [],
      balance: BALANCE_RESET,
      saved: [],
    });
  }
  return users.get(id);
}

function formatEventCard(ev) {
  return (
    `🎭 *${ev.title}*\n` +
    `${ev.date} в ${ev.time} · ${ev.address}\n` +
    `${ev.price} ₽ по Пушкинской карте\n` +
    `${ev.description}`
  );
}

async function handleOnboardingStep(userId, user, text) {
  if (user.step === 'new') {
    user.step = 'ask_interests';
    await sendMessage(
      userId,
      'Привет! Я помогу подобрать, куда сходить по Пушкинской карте, и не дам баллам сгореть.\n\n' +
        'Какие форматы интересны? Напиши через запятую: театр, музеи, концерты, кино, мастер-классы, экскурсии.'
    );
    return true;
  }
  if (user.step === 'ask_interests') {
    user.interests = text
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    user.step = 'ask_balance';
    await sendMessage(
      userId,
      'Отлично. Сколько баллов Пушкинской карты у тебя сейчас осталось? (Если не знаешь — напиши "не знаю", поставлю 5000)'
    );
    return true;
  }
  if (user.step === 'ask_balance') {
    const num = parseInt(text.replace(/\D/g, ''), 10);
    user.balance = Number.isFinite(num) && num > 0 ? num : BALANCE_RESET;
    user.step = 'ready';
    await sendMessage(
      userId,
      `Готово! Баланс: ${user.balance} ₽.\n\n` +
        'Дальше можно:\n' +
        '• написать, что хочется («культурно провести субботу недорого»)\n' +
        '• «баллы 3000» — обновить баланс\n' +
        '• «открыть каталог» — посмотреть все варианты в мини-приложении',
      { keyboard: miniAppButton('📱 Открыть каталог', {
          balance: user.balance,
          interests: user.interests,
          city: user.city,
        }) }
    );
    return true;
  }
  return false;
}

async function handleReadyMessage(userId, user, text) {
  const lower = text.toLowerCase().trim();

  if (lower.startsWith('баллы')) {
    const num = parseInt(lower.replace(/\D/g, ''), 10);
    if (Number.isFinite(num)) {
      user.balance = num;
      await sendMessage(userId, `Баланс обновлён: ${num} ₽.`);
    } else {
      await sendMessage(userId, 'Не понял число. Напиши, например: "баллы 2500".');
    }
    return;
  }

  if (lower.includes('каталог') || lower.includes('приложен')) {
    await sendMessage(userId, 'Открывай мини-приложение — там весь каталог с фильтрами:', {
      keyboard: miniAppButton('📱 Открыть каталог', {
        balance: user.balance,
        interests: user.interests,
        city: user.city,
      }),
    });
    return;
  }

  // Default: treat the message as a free-text search request.
  const filters = await parseQueryToFilters(text);
  filters.city = user.city;
  filters.maxPrice = filters.maxPrice ?? user.balance;

  const matches = filterEvents(filters).slice(0, 3);
  if (matches.length === 0) {
    await sendMessage(
      userId,
      'Под такой запрос сейчас ничего не нашлось. Попробуй другую формулировку или открой полный каталог.',
      { keyboard: miniAppButton('📱 Открыть каталог', {
          balance: user.balance,
          interests: user.interests,
          city: user.city,
        }) }
    );
    return;
  }

  for (const ev of matches) {
    const reason = await explainMatch(ev, user.interests);
    await sendMessage(userId, `${formatEventCard(ev)}\n\n_${reason}_`, { format: 'markdown' });
  }
}

app.post('/webhook', async (req, res) => {
  // MAX sends update objects; the shape below follows the documented
  // message_created update. Confirm field names against the live docs
  // before the submission deadline.
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && req.get('X-Max-Bot-Api-Secret') !== expectedSecret) {
    return res.sendStatus(401);
  }
  try {
    const update = req.body;
    console.log('Incoming update:', JSON.stringify(update));

    const message = update?.message;
    const userId = message?.sender?.user_id;
    const text = message?.body?.text;

    if (!userId || !text) {
      console.warn('Ignoring update — missing sender/text at message.sender.user_id / message.body.text. Check the logged payload above against your MAX API version.');
      return res.sendStatus(200); // ignore non-text updates for this MVP
    }

    const user = getUser(userId);
    const handledOnboarding = await handleOnboardingStep(userId, user, text);
    if (!handledOnboarding) {
      await handleReadyMessage(userId, user, text);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    // Always 200 back to the platform so it doesn't retry-storm us; the
    // user just gets no reply for this one message, per the "user can
    // continue without a full restart" stability criterion.
    res.sendStatus(200);
  }
});

// Simple daily check for balances close to expiring — call this from an
// external scheduler (cron, Render cron job, GitHub Actions schedule) since
// we don't run our own always-on worker on the free tier.
app.post('/tasks/balance-reminders', async (_req, res) => {
  const now = new Date();
  const yearEnd = new Date(now.getFullYear(), 11, 31);
  const daysLeft = Math.ceil((yearEnd - now) / (1000 * 60 * 60 * 24));

  if (daysLeft > REMINDER_DAYS_BEFORE) {
    return res.json({ sent: 0, reason: 'not in reminder window yet' });
  }

  let sent = 0;
  for (const [userId, user] of users.entries()) {
    if (user.balance > 0) {
      await sendMessage(
        userId,
        `Напоминание: у тебя ещё ${user.balance} ₽ баллов Пушкинской карты, ` +
          `они сгорают через ${daysLeft} дней. Могу сразу показать варианты — просто напиши, что интересно.`
      );
      sent += 1;
    }
  }
  res.json({ sent });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Bot server listening on port ${PORT}`);
});
