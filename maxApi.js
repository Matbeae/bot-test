// Thin wrapper around the MAX Bot API (dev.max.ru/docs-api).
// NOTE: verify field/endpoint names against the current MAX docs before
// submission — the platform's API can change, as the hackathon brief itself
// warns. This wrapper isolates that surface to one file so an update only
// needs to happen here.
//
// As of writing: the API domain is platform-api.max.ru (the older
// botapi.max.ru is being retired), and the token goes in an
// `Authorization: <token>` header — the old `?access_token=` query
// parameter is no longer accepted.

const BASE_URL = (process.env.MAX_API_URL || 'https://platform-api.max.ru').replace(/\/+$/, '');
const TOKEN = process.env.MAX_BOT_TOKEN || '';

async function callMax(endpoint, { method = 'GET', query = {}, body } = {}) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  const url = `${BASE_URL}${endpoint}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MAX API ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function sendMessage(userId, text, { keyboard, format } = {}) {
  const attachments = [];
  if (keyboard) {
    // MAX expects buttons grouped into rows: an array of arrays, even for
    // a single button. `keyboard` here is already that shape (see
    // miniAppButton below) — don't double-wrap it.
    attachments.push({
      type: 'inline_keyboard',
      payload: { buttons: keyboard },
    });
  }
  return callMax('/messages', {
    method: 'POST',
    query: { user_id: userId },
    body: { text, format, attachments },
  });
}

// Registers (or re-registers) the webhook with MAX. There is no UI field
// for this in the bot cabinet — MAX only exposes it via this API call.
// Run once after each deploy where the public URL changes (e.g. via
// `npm run set-webhook`, see package.json).
function subscribe(url, { updateTypes = ['message_created', 'bot_started'], secret } = {}) {
  return callMax('/subscriptions', {
    method: 'POST',
    body: { url, update_types: updateTypes, secret },
  });
}

function listSubscriptions() {
  return callMax('/subscriptions');
}

function unsubscribe(url) {
  return callMax('/subscriptions', { method: 'DELETE', body: { url } });
}

function encodeSettingsPayload(settings) {
  // base64url alphabet (A-Za-z0-9-_) matches exactly what MAX allows in a
  // startapp payload, so this is safe to use both in the open_app payload
  // field and in a plain query string.
  return Buffer.from(JSON.stringify(settings)).toString('base64url');
}

// A real native Mini App button (type "open_app") only works once the
// mini-app's HTTPS URL is registered against this bot in the MAX business
// cabinet (business.max.ru/self → организация → бот → раздел
// "Мини-приложения"). That step needs the org owner/admin to do it — once
// done, set MINIAPP_MODE=native and the bot switches to the native button;
// until then it falls back to a plain link that opens the same page in an
// external browser, which still lets the scenario be demoed end to end.
//
// `settings` (optional) is the user's onboarding state — { balance,
// interests, city } — passed through as a payload so the mini-app opens
// pre-filled instead of resetting to defaults. miniapp/app.js reads it back
// from the query string (link mode) or from window.WebApp.initData (native
// mode, field name unconfirmed — verify against real behavior).
function miniAppButton(label, settings) {
  const miniAppUrl = process.env.MINIAPP_URL || 'https://example.github.io/max-leisure-hackathon/';
  const isNative = (process.env.MINIAPP_MODE || 'link').toLowerCase() === 'native';
  const payload = settings ? encodeSettingsPayload(settings) : undefined;

  if (isNative) {
    const button = { type: 'open_app', text: label };
    if (payload) button.payload = payload;
    return [[button]];
  }

  const url = payload ? `${miniAppUrl}?start=${payload}` : miniAppUrl;
  return [[{ type: 'link', text: label, url }]];
}

module.exports = { callMax, sendMessage, miniAppButton, subscribe, listSubscriptions, unsubscribe };
