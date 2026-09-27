// Run once after each deploy where the public bot URL changes:
//   node set-webhook.js
// Reads MAX_BOT_TOKEN, MINIAPP_URL is not used here — this is about the
// bot's own webhook endpoint, configured via WEBHOOK_URL (or built from
// RENDER_EXTERNAL_URL if you're on Render, which sets that automatically).

const { subscribe, listSubscriptions } = require('./maxApi');

async function main() {
  const base = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) {
    console.error(
      'Set WEBHOOK_URL to your public HTTPS base URL (e.g. https://your-bot.onrender.com) before running this script.'
    );
    process.exit(1);
  }
  const url = base.replace(/\/$/, '') + '/webhook';
  const secret = process.env.WEBHOOK_SECRET || undefined;

  console.log('Subscribing webhook to:', url);
  const result = await subscribe(url, {
    updateTypes: ['message_created', 'bot_started'],
    secret,
  });
  console.log('Subscribe response:', result);

  const current = await listSubscriptions();
  console.log('Active subscriptions:', current);
}

main().catch((err) => {
  console.error('Failed to set webhook:', err.message);
  process.exit(1);
});
