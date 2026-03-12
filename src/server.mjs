import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { getActiveAlertsForLocation, buildAlertFingerprint, buildPushMessage, getPointMetadata } from './nws.mjs';
import { getAllDevices, getDevice, upsertDevice, wasAlertSent, markAlertSent } from './store.mjs';
import { sendNotification } from './notifier.mjs';

const app = express();
const port = Number(process.env.PORT || 3000);
const pollSeconds = Math.max(30, Number(process.env.ALERT_POLL_SECONDS || 60));
const defaultDeepLink = process.env.DEFAULT_DEEP_LINK || '/pages/alerts';
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

app.use(express.json({ limit: '250kb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

function normalizeNumber(value, fieldName) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  return n;
}

function buildDeviceId() {
  return crypto.randomUUID();
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WeatherPulse Alerts Server</title>
  <style>
    body { font-family: Arial, sans-serif; background:#081426; color:#f2f7ff; padding:24px; }
    .card { max-width:760px; margin:0 auto; background:#0d203f; border:1px solid rgba(150,190,255,.2); border-radius:18px; padding:20px; }
    a { color:#6fc0ff; }
    code { background:rgba(255,255,255,.08); padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WeatherPulse alerts server is running</h1>
    <p>This server is live.</p>
    <p>Health check: <a href="${baseUrl}/health">${baseUrl}/health</a></p>
    <p>Manual alert check: send a POST request to <code>${baseUrl}/api/cron/check-alerts</code></p>
  </div>
</body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'weatherpulse-goodbarber-location-alerts' });
});

app.post('/api/register-location', async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = String(body.deviceId || '').trim() || buildDeviceId();
    const lat = normalizeNumber(body.lat, 'lat');
    const lon = normalizeNumber(body.lon, 'lon');
    const metadata = await getPointMetadata(lat, lon);

    const saved = upsertDevice(deviceId, {
      lat,
      lon,
      appUser: body.appUser || null,
      platform: body.platform || null,
      pushOptIn: body.pushOptIn !== false,
      metadata,
      firstSeenAt: getDevice(deviceId)?.firstSeenAt || new Date().toISOString()
    });

    res.json({ ok: true, device: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/device/:deviceId', (req, res) => {
  const device = getDevice(req.params.deviceId);
  if (!device) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }
  return res.json({ ok: true, device });
});

app.get('/api/alerts/me/:deviceId', async (req, res) => {
  try {
    const device = getDevice(req.params.deviceId);
    if (!device) {
      return res.status(404).json({ ok: false, error: 'Device not found' });
    }

    const result = await getActiveAlertsForLocation(device.lat, device.lon);
    return res.json({ ok: true, device, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

async function runAlertCheckCycle() {
  const devices = Object.values(getAllDevices()).filter((device) => device?.pushOptIn !== false);
  const notifications = [];

  for (const device of devices) {
    try {
      const { alerts, metadata } = await getActiveAlertsForLocation(device.lat, device.lon);

      for (const alert of alerts) {
        const fingerprint = buildAlertFingerprint(alert);
        if (wasAlertSent(device.deviceId, fingerprint)) {
          continue;
        }

        const payload = {
          deviceId: device.deviceId,
          appUser: device.appUser || null,
          platform: device.platform || null,
          lat: device.lat,
          lon: device.lon,
          pointMetadata: metadata,
          alertId: alert.id,
          event: alert.event,
          severity: alert.severity,
          urgency: alert.urgency,
          certainty: alert.certainty,
          title: alert.event,
          message: buildPushMessage(alert),
          headline: alert.headline,
          areaDesc: alert.areaDesc,
          effective: alert.effective,
          expires: alert.expires,
          instruction: alert.instruction,
          description: alert.description,
          response: alert.response,
          senderName: alert.senderName,
          deepLink: defaultDeepLink
        };

        const notifyResult = await sendNotification(payload);

        if (notifyResult?.ok || notifyResult?.skipped) {
          markAlertSent(device.deviceId, fingerprint, {
            alertId: alert.id,
            event: alert.event,
            severity: alert.severity,
            notifyResult
          });
        }

        notifications.push({
          deviceId: device.deviceId,
          alertId: alert.id,
          event: alert.event,
          severity: alert.severity,
          notifyResult
        });
      }
    } catch (error) {
      notifications.push({
        deviceId: device.deviceId,
        error: error.message
      });
    }
  }

  return {
    checkedDevices: devices.length,
    notificationsSent: notifications.filter((n) => n.notifyResult?.ok).length,
    notificationsSkipped: notifications.filter((n) => n.notifyResult?.skipped).length,
    details: notifications
  };
}

async function handleManualCheck(res) {
  try {
    const result = await runAlertCheckCycle();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

app.post('/api/cron/check-alerts', async (_req, res) => {
  await handleManualCheck(res);
});

app.get('/api/cron/check-alerts', async (_req, res) => {
  await handleManualCheck(res);
});

app.listen(port, () => {
  console.log(`WeatherPulse alerts server listening on ${baseUrl}`);
  console.log(`Polling every ${pollSeconds} seconds`);
});

setInterval(async () => {
  try {
    const result = await runAlertCheckCycle();
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] checked=${result.checkedDevices} sent=${result.notificationsSent} skipped=${result.notificationsSkipped}`);
  } catch (error) {
    console.error('Alert poller failed:', error);
  }
}, pollSeconds * 1000);
