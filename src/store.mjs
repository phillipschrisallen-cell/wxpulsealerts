import fs from 'fs';
import path from 'path';

const STORE_DIR = process.env.STORE_DIR || './data';
const devicesFile = path.join(STORE_DIR, 'devices.json');
const sentAlertsFile = path.join(STORE_DIR, 'sent-alerts.json');

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}

function readJson(filePath, fallback) {
  ensureFile(filePath, fallback);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureFile(filePath, value);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function getAllDevices() {
  return readJson(devicesFile, {});
}

export function getDevice(deviceId) {
  const devices = getAllDevices();
  return devices[deviceId] || null;
}

export function upsertDevice(deviceId, patch) {
  const devices = getAllDevices();
  const existing = devices[deviceId] || {};
  devices[deviceId] = {
    ...existing,
    ...patch,
    deviceId,
    updatedAt: new Date().toISOString()
  };
  writeJson(devicesFile, devices);
  return devices[deviceId];
}

export function getSentAlerts() {
  return readJson(sentAlertsFile, {});
}

export function wasAlertSent(deviceId, fingerprint) {
  const sent = getSentAlerts();
  return Boolean(sent[deviceId]?.[fingerprint]);
}

export function markAlertSent(deviceId, fingerprint, payload = {}) {
  const sent = getSentAlerts();
  if (!sent[deviceId]) sent[deviceId] = {};
  sent[deviceId][fingerprint] = {
    ...payload,
    sentAt: new Date().toISOString()
  };
  writeJson(sentAlertsFile, sent);
}
