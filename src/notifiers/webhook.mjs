export async function sendWebhookNotification(payload) {
  const webhookUrl = process.env.PUSH_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('PUSH_WEBHOOK_URL is not set. Notification payload:', payload);
    return { ok: false, skipped: true, reason: 'missing PUSH_WEBHOOK_URL' };
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: text
  };
}
