const { ruleBasedParse } = require('./events');

// Pick a provider with LLM_PROVIDER=groq (default) or LLM_PROVIDER=openrouter.
// Both use OpenAI-compatible chat-completions endpoints, so this is a thin
// switch rather than two separate integrations.
const PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    extraHeaders: {},
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    // Free-tier model; swap for another from openrouter.ai/models if this
    // one is retired or rate-limited.
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
    extraHeaders: {
      // OpenRouter asks for these to attribute traffic; harmless if wrong.
      'HTTP-Referer': process.env.MINIAPP_URL || 'https://example.com',
      'X-Title': 'Карта в дело',
    },
  },
};

async function callLLM(messages, { json = false } = {}) {
  const cfg = PROVIDERS[PROVIDER];
  if (!cfg || !cfg.apiKey) {
    throw new Error(`LLM provider "${PROVIDER}" has no API key set`);
  }
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.extraHeaders,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      max_tokens: 300,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${PROVIDER} API error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * Turns a free-text user request into structured filters.
 * Falls back to a simple rule-based parser if the LLM call fails
 * (keeps the main scenario working without the LLM dependency).
 */
async function parseQueryToFilters(text) {
  try {
    const raw = await callLLM(
      [
        {
          role: 'system',
          content:
            'Ты помогаешь подобрать досуг по Пушкинской карте. Верни JSON строго вида ' +
            '{"category": "museum|theatre|concert|workshop|cinema|excursion|null", ' +
            '"maxPrice": число или null, "keywords": [строки]}. Никакого текста кроме JSON.',
        },
        { role: 'user', content: text },
      ],
      { json: true }
    );
    const parsed = JSON.parse(raw);
    const filters = {};
    if (parsed.category) filters.category = parsed.category;
    if (typeof parsed.maxPrice === 'number') filters.maxPrice = parsed.maxPrice;
    if (Array.isArray(parsed.keywords) && parsed.keywords.length) {
      filters.keywords = parsed.keywords;
    }
    return filters;
  } catch (err) {
    console.warn('LLM parse failed, falling back to rule-based parser:', err.message);
    return ruleBasedParse(text);
  }
}

/**
 * Generates a one-sentence personalized reason why an event fits the user.
 * Falls back to a plain templated sentence if the LLM call fails.
 */
async function explainMatch(event, interests) {
  try {
    const text = await callLLM([
      {
        role: 'system',
        content:
          'Одним коротким предложением на русском объясни, почему это мероприятие ' +
          'подойдёт человеку с такими интересами. Без вступлений, только суть.',
      },
      {
        role: 'user',
        content: `Интересы: ${interests.join(', ') || 'не указаны'}. Мероприятие: ${event.title} — ${event.description}`,
      },
    ]);
    return text.trim();
  } catch (err) {
    return `Подходит по категории «${event.category}» и укладывается в твой бюджет баллов.`;
  }
}

module.exports = { parseQueryToFilters, explainMatch };
