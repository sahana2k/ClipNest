// lib/storage.js
// Use promise-wrapped chrome.storage.local helpers to ensure compatibility
const KEY = 'clipnest/cards';
const SETTINGS_KEY = 'clipnest/settings';

function _storageGet(key) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
    } catch (e) { reject(e); }
  });
}

function _storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    } catch (e) { reject(e); }
  });
}

export async function readAll() {
  const obj = await _storageGet(KEY).catch(() => ({}));
  return obj[KEY] || [];
}

export async function writeAll(cards) {
  await _storageSet({ [KEY]: cards || [] });
}

export async function addCard(card) {
  const cards = await readAll();
  // Ensure a stable id and createdAt timestamp so cards are manageable
  const toAdd = { ...(card || {}) };
  if (!toAdd.id) {
    try { toAdd.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2,9); } catch (e) { toAdd.id = crypto.randomUUID ? crypto.randomUUID() : ('id-' + Math.random().toString(36).slice(2,9)); }
  }
  if (!toAdd.createdAt) toAdd.createdAt = Date.now();
  cards.push(toAdd);
  await writeAll(cards);
  return toAdd;
}

export async function removeCard(cardId) {
  const cards = await readAll();
  const out = cards.filter(c => c.id !== cardId);
  await writeAll(out);
  return out;
}

export async function getBySubject(subject) {
  if (!subject) return await readAll();
  const cards = await readAll();
  return cards.filter(c => (c.subject || 'General').toLowerCase() === subject.toLowerCase());
}

export async function updateCard(updated) {
  const cards = await readAll();
  const out = cards.map(c => (c.id === updated.id ? { ...c, ...updated } : c));
  await writeAll(out);
  return out;
}

export async function searchCards(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return await readAll();
  const cards = await readAll();
  return cards.filter(c => {
    if (!c) return false;
    const fields = [c.subject, c.topic, c.source?.title, c.source?.url, c.snippet?.text, c.notes?.short || c.notes || ''].join(' ');
    const tags = (c.tags || []).join(' ');
    const qa = (c.qa || []).map(x => `${x.q} ${x.a}`).join(' ');
    const hay = (fields + ' ' + tags + ' ' + qa).toLowerCase();
    return hay.includes(q);
  });
}

export async function readSettings() {
  const obj = await _storageGet(SETTINGS_KEY).catch(() => ({}));
  return obj[SETTINGS_KEY] || {};
}

export async function writeSettings(settings) {
  await _storageSet({ [SETTINGS_KEY]: settings || {} });
}

export async function updateSettings(patch) {
  const cur = await readSettings();
  const next = { ...cur, ...(patch || {}) };
  await writeSettings(next);
  return next;
}

// Write ephemeral debug information (opt-in). Stored under 'clipnest/debug/lastAiResponse'
export async function writeDebugResponse(obj) {
  try {
    await _storageSet({ ['clipnest/debug/lastAiResponse']: obj || null });
  } catch (e) {
    console.debug('Failed to write debug response', e);
  }
}

// Migrate local -> cloud: merges local and cloud sets and writes merged to cloud (if configured)
export async function migrateLocalToCloud() {
  const settings = await readSettings().catch(() => ({}));
  const cloud = settings?.cloud;
  if (!cloud || !cloud.enabled || !cloud.url) throw new Error('cloud-not-configured');
  const base = cloud.url.replace(/\/$/, '');

  const localObj = await _storageGet(KEY).catch(() => ({}));
  const localCards = localObj[KEY] || [];

  let cloudCards = [];
  try {
    const res = await fetch(base + '/cards', { method: 'GET', headers: cloud.token ? { Authorization: 'Bearer ' + cloud.token } : {} });
    if (res.ok) {
      const json = await res.json();
      cloudCards = Array.isArray(json) ? json : (json.cards || []);
    }
  } catch (e) { console.debug('[storage] cloud read during migrate failed', e); }

  // merge (local then cloud, cloud entries overwrite local by id)
  const map = new Map();
  for (const c of localCards) if (c && c.id) map.set(c.id, c);
  for (const c of cloudCards) if (c && c.id) map.set(c.id, c);
  const merged = Array.from(map.values());

  // write merged to cloud
  const putRes = await fetch(base + '/cards', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, cloud.token ? { Authorization: 'Bearer ' + cloud.token } : {}), body: JSON.stringify(merged) });
  if (!putRes.ok) throw new Error('cloud-write-failed:' + putRes.status);

  // persist merged locally
  await _storageSet({ [KEY]: merged });
  return merged;
}
