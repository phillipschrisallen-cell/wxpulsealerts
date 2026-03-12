import { sendWebhookNotification } from './notifiers/webhook.mjs';

export async function sendNotification(payload) {
  const mode = (process.env.PUSH_MODE || 'webhook').toLowerCase();

  switch (mode) {
    case 'webhook':
      return sendWebhookNotification(payload);
    default:
      throw new Error(`Unsupported PUSH_MODE: ${mode}`);
  }
}
