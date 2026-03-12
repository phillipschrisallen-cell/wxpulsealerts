const USER_AGENT = process.env.NWS_USER_AGENT || 'WeatherPulseAlerts/1.0 (you@example.com)';
const ALERT_EVENTS = (process.env.ALERT_EVENTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const COORD_PRECISION = Number(process.env.COORD_PRECISION || 4);

const pointsCache = new Map();
const pointsTtlMs = 6 * 60 * 60 * 1000;

function roundCoord(value) {
  return Number(Number(value).toFixed(COORD_PRECISION));
}

function nwsHeaders() {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'application/geo+json, application/ld+json, application/json'
  };
}

async function getJson(url) {
  const response = await fetch(url, { headers: nwsHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NWS request failed ${response.status} for ${url}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

function extractZoneCode(zoneUrl) {
  if (!zoneUrl) return null;
  const clean = String(zoneUrl).replace(/\/+$/, '');
  return clean.split('/').pop() || null;
}

export async function getPointMetadata(lat, lon) {
  const roundedLat = roundCoord(lat);
  const roundedLon = roundCoord(lon);
  const key = `${roundedLat},${roundedLon}`;
  const now = Date.now();

  const cached = pointsCache.get(key);
  if (cached && now - cached.savedAt < pointsTtlMs) {
    return cached.value;
  }

  const point = await getJson(`https://api.weather.gov/points/${roundedLat},${roundedLon}`);
  const properties = point.properties || {};

  const metadata = {
    lat: roundedLat,
    lon: roundedLon,
    countyUrl: properties.county || null,
    countyCode: extractZoneCode(properties.county),
    forecastZoneUrl: properties.forecastZone || null,
    forecastZoneCode: extractZoneCode(properties.forecastZone),
    fireWeatherZoneUrl: properties.fireWeatherZone || null,
    fireWeatherZoneCode: extractZoneCode(properties.fireWeatherZone),
    radarStation: properties.radarStation || null,
    cwa: properties.cwa || null,
    timeZone: properties.timeZone || null
  };

  pointsCache.set(key, { savedAt: now, value: metadata });
  return metadata;
}

function normalizeAlert(feature) {
  const p = feature?.properties || {};
  return {
    id: feature.id || p.id || p['@id'] || null,
    event: p.event || 'Weather Alert',
    headline: p.headline || null,
    severity: p.severity || 'Unknown',
    certainty: p.certainty || 'Unknown',
    urgency: p.urgency || 'Unknown',
    areaDesc: p.areaDesc || '',
    effective: p.effective || null,
    expires: p.expires || null,
    ends: p.ends || null,
    sent: p.sent || null,
    status: p.status || null,
    messageType: p.messageType || null,
    instruction: p.instruction || '',
    description: p.description || '',
    response: p.response || '',
    senderName: p.senderName || '',
    severityRank: severityRank(p.severity || 'Unknown')
  };
}

function severityRank(severity) {
  const map = {
    Unknown: 0,
    Minor: 1,
    Moderate: 2,
    Severe: 3,
    Extreme: 4
  };
  return map[severity] ?? 0;
}

export function minSeverityRank() {
  return severityRank(process.env.MIN_SEVERITY || 'Moderate');
}

export async function getActiveAlertsForLocation(lat, lon) {
  const metadata = await getPointMetadata(lat, lon);
  const zoneCodes = [
    metadata.countyCode,
    metadata.forecastZoneCode
  ].filter(Boolean);

  const alerts = [];
  const seenIds = new Set();

  for (const zoneCode of zoneCodes) {
    const url = `https://api.weather.gov/alerts/active?zone=${encodeURIComponent(zoneCode)}`;
    const data = await getJson(url);
    const features = Array.isArray(data.features) ? data.features : [];

    for (const feature of features) {
      const alert = normalizeAlert(feature);
      if (!alert.id || seenIds.has(alert.id)) continue;
      seenIds.add(alert.id);
      alerts.push(alert);
    }
  }

  const filtered = alerts.filter((alert) => {
    const eventPass = ALERT_EVENTS.length === 0 || ALERT_EVENTS.includes(alert.event);
    const severityPass = alert.severityRank >= minSeverityRank();
    return eventPass && severityPass;
  });

  filtered.sort((a, b) => {
    if (b.severityRank !== a.severityRank) return b.severityRank - a.severityRank;
    return new Date(b.sent || 0).getTime() - new Date(a.sent || 0).getTime();
  });

  return {
    metadata,
    alerts: filtered
  };
}

export function buildAlertFingerprint(alert) {
  return [alert.id, alert.sent || '', alert.expires || '', alert.status || '', alert.messageType || ''].join('::');
}

export function buildPushMessage(alert) {
  const until = alert.expires || alert.ends;
  const untilText = until
    ? new Date(until).toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        month: 'numeric',
        day: 'numeric'
      })
    : null;

  const area = alert.areaDesc || 'your area';
  return `${area}${untilText ? ` until ${untilText}` : ''}`;
}
