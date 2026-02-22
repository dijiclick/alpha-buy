import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function normalizeState(raw) {
  const alerts = {};
  const src = raw && typeof raw === 'object' ? raw.alerts : null;
  if (src && typeof src === 'object') {
    for (const [key, value] of Object.entries(src)) {
      if (!value || typeof value !== 'object') continue;
      const sentAt = String(value.sent_at || '');
      if (!sentAt) continue;
      alerts[key] = {
        sent_at: sentAt,
        last_net_edge: Number(value.last_net_edge) || 0,
        last_confidence: Number(value.last_confidence) || 0,
      };
    }
  }
  return { version: 1, alerts };
}

function pruneState(state, maxAgeHours = 24 * 7) {
  const cutoff = Date.now() - (maxAgeHours * 3600_000);
  for (const [key, value] of Object.entries(state.alerts || {})) {
    const ts = new Date(value.sent_at || '').getTime();
    if (!Number.isFinite(ts) || ts < cutoff) {
      delete state.alerts[key];
    }
  }
  return state;
}

export function loadAlertState(path, maxAgeHours = 24 * 7) {
  ensureParentDir(path);
  if (!existsSync(path)) {
    return { version: 1, alerts: {} };
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return pruneState(normalizeState(raw), maxAgeHours);
  } catch {
    return { version: 1, alerts: {} };
  }
}

export function saveAlertState(path, state, maxAgeHours = 24 * 7) {
  ensureParentDir(path);
  const normalized = pruneState(normalizeState(state), maxAgeHours);
  writeFileSync(path, JSON.stringify(normalized, null, 2));
}

export function isDuplicateWithinWindow(state, key, hours, nowTs = Date.now()) {
  const item = state?.alerts?.[key];
  if (!item || !item.sent_at) return false;
  const sentTs = new Date(item.sent_at).getTime();
  if (!Number.isFinite(sentTs)) return false;
  return (nowTs - sentTs) < (hours * 3600_000);
}

export function markSent(state, key, payload, nowIso = new Date().toISOString()) {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid alert state');
  }
  if (!state.alerts || typeof state.alerts !== 'object') {
    state.alerts = {};
  }
  state.alerts[key] = {
    sent_at: nowIso,
    last_net_edge: Number(payload?.last_net_edge) || 0,
    last_confidence: Number(payload?.last_confidence) || 0,
  };
}

