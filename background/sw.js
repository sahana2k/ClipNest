// background/sw.js
import { getDueCount } from '../lib/scheduler.js';
import { readAll } from '../lib/storage.js';
import { remoteExplainToCard } from '../lib/prompt.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;

function log(...args) { console.log('[SW]', ...args); }

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

async function waitForOffscreenReady(ms = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (m) => {
      try {
        if (m && m.type === 'CLIPNEST_OFFSCREEN_READY') {
          done = true;
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve(true);
        }
      } catch (e) { /* ignore */ }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    setTimeout(() => { if (!done) { chrome.runtime.onMessage.removeListener(onMsg); resolve(false); } }, ms);
  });
}

async function ensureOffscreen() {
    try {
      const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
      // If an offscreen document is already present, attempt to verify ready
      try {
        const ready = await waitForOffscreenReady(1000);
        if (ready) return;
      } catch (e) { /* fall through to recreate */ }

    if (creatingOffscreen) return creatingOffscreen;
    creatingOffscreen = (async () => {
      try {
        await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ['BLOBS'], justification: 'Crop images for ClipNest' });
      } catch (errCreate) {
        log('chrome.offscreen.createDocument failed', errCreate);
        throw errCreate;
      }
      // wait longer for the offscreen script to signal readiness on slow devices
      const ok = await waitForOffscreenReady(5000);
      if (!ok) throw new Error('Offscreen document did not respond');
      creatingOffscreen = null;
    })();
    return creatingOffscreen;
    } catch (err) {
      creatingOffscreen = null;
      log('ensureOffscreen error', err);
      throw err;
    }
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res?.[key]);
      });
    } catch (e) { reject(e); }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    } catch (e) { reject(e); }
  });
}

function storageRemove(key) {
  return new Promise((resolve) => {
    try { chrome.storage.local.remove(key, () => resolve()); } catch (e) { resolve(); }
  });
}

function waitForMessage(filterFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMsg = (m) => {
      try {
        if (filterFn(m)) {
          settled = true;
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve(m);
        }
      } catch (e) { /* ignore */ }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const to = setTimeout(() => {
      if (!settled) {
        chrome.runtime.onMessage.removeListener(onMsg);
        reject(new Error('timeout'));
      }
    }, timeoutMs || 5000);
  });
}

async function tryContentCrop(tabId, requestId, dataUrlKey, dataUrl, rect, dpr) {
  try {
    // ask page to crop; the page may read the capture from storage by key
    chrome.tabs.sendMessage(tabId, { type: 'CLIPNEST_CONTENT_CROP', requestId, dataUrlKey, dataUrl, rect, dpr }).catch(() => {});
    const msg = await waitForMessage((m) => m && m.requestId === requestId && (m.type === 'CLIPNEST_CROPPED_BLOB' || m.type === 'CLIPNEST_CROPPED' || m.type === 'CLIPNEST_CROPPED_KEY'), 6000).catch(() => null);
    if (!msg) return null;
    if (msg.type === 'CLIPNEST_CROPPED_BLOB') return { cropBlob: msg.blob };
    if (msg.type === 'CLIPNEST_CROPPED') return { croppedDataUrl: msg.croppedDataUrl };
    if (msg.type === 'CLIPNEST_CROPPED_KEY') {
      const stored = await storageGet(msg.cropKey).catch(() => null);
      await storageRemove(msg.cropKey).catch(() => {});
      if (stored) return { croppedDataUrl: stored };
    }
    return null;
  } catch (e) { log('tryContentCrop error', e); return null; }
}

async function handleSelection(msg) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) { await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', message: 'No active tab' }); return; }
  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file://')) {
    await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', message: 'Cannot capture this page' }); return;
  }

  let dataUrl;
  try { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); } catch (e) { log('captureVisibleTab failed', e); await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', message: 'Unable to capture the page' }); return; }

  // write capture to storage under a short key so page/offscreen can access it if needed
  const key = `clipnest:data:${msg.requestId}`;
  try { await storageSet({ [key]: dataUrl }); } catch (e) { log('storageSet failed for capture key', e); }

  // First try content-script crop
  let cropResult = await tryContentCrop(tab.id, msg.requestId, key, dataUrl, msg.rect, msg.dpr);
  if (!cropResult) {
    // fallback to offscreen
    try {
      await ensureOffscreen();
    } catch (e) { log('ensureOffscreen failed', e); await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', message: 'Offscreen unavailable' }); return; }

    // attempt to create a Blob to transfer (preferred). If it fails we'll include dataUrl and let offscreen read from storage
    let imageBlob = null;
    try { const resp = await fetch(dataUrl); imageBlob = await resp.blob(); } catch (e) { log('converting dataUrl to blob failed', e); imageBlob = null; }

    // send request to offscreen
    try {
      chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_IMAGE', requestId: msg.requestId, dataUrlKey: key, dataUrl, imageBlob, rect: msg.rect, dpr: msg.dpr });

      // Wait for offscreen responses
      // First wait for start to extend timeout
      await waitForMessage((m) => m && m.type === 'CLIPNEST_CROP_STARTED' && m.requestId === msg.requestId, 5000).catch(() => null);
      // Now wait longer for completion
      const completion = await waitForMessage((m) => m && m.requestId === msg.requestId && (m.type === 'CLIPNEST_CROPPED_BLOB' || m.type === 'CLIPNEST_CROPPED_KEY' || m.type === 'CLIPNEST_CROPPED' || m.type === 'CLIPNEST_ERROR'), 120000).catch((e) => { log('offscreen completion wait timeout', e); return null; });
      if (!completion) { await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg.requestId, message: 'Crop operation timed out' }); return; }
      if (completion.type === 'CLIPNEST_ERROR') { await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg.requestId, message: completion.message || 'Offscreen crop failed' }); return; }
      if (completion.type === 'CLIPNEST_CROPPED_BLOB') { cropResult = { cropBlob: completion.blob }; }
      else if (completion.type === 'CLIPNEST_CROPPED') { cropResult = { croppedDataUrl: completion.croppedDataUrl }; }
      else if (completion.type === 'CLIPNEST_CROPPED_KEY') {
        const stored = await storageGet(completion.cropKey).catch(() => null);
        await storageRemove(completion.cropKey).catch(() => {});
        if (stored) cropResult = { croppedDataUrl: stored };
      }
    } catch (e) { log('offscreen path failed', e); await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg.requestId, message: 'Crop failed' }); return; }
  }

  if (!cropResult || (!cropResult.croppedDataUrl && !cropResult.cropBlob)) {
    await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg.requestId, message: 'No crop result' });
    return;
  }

  console.info('[SW] cropResult for', msg.requestId, cropResult ? (cropResult.croppedDataUrl ? 'hasDataUrl' : (cropResult.cropBlob ? 'hasBlob' : 'empty')) : 'null');

  const readyMsg = { type: 'CLIPNEST_CROP_READY', requestId: msg.requestId, page: { url: msg.url, title: msg.title }, textInRect: msg.textInRect, rect: msg.rect };
  // If we have a Blob but the extension contexts may not accept it downstream,
  // convert the blob to a data URL here as a reliable fallback so the sidepanel
  // always receives a renderable image. This avoids FileReader errors in the UI.
  if (cropResult.croppedDataUrl) {
    readyMsg.cropDataUrl = cropResult.croppedDataUrl;
  } else if (cropResult.cropBlob) {
    try {
      // Convert blob -> dataURL in the service worker context
      const blob = cropResult.cropBlob;
      if (blob && typeof blob.arrayBuffer === 'function') {
        console.info('[SW] converting blob to dataUrl for', msg.requestId);
        const ab = await blob.arrayBuffer();
        const u8 = new Uint8Array(ab);
        // Convert in chunks to avoid call stack issues for large blobs
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < u8.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
        }
        const b64 = btoa(binary);
        const mime = blob.type || 'image/png';
        readyMsg.cropDataUrl = `data:${mime};base64,${b64}`;
        console.info('[SW] blob->dataUrl conversion complete for', msg.requestId);
      } else {
        // blob-like object lacks arrayBuffer() — try storage fallback written by
        // the content script under `clipnest:crop:<requestId>`.
        try {
          const key = `clipnest:crop:${msg.requestId}`;
          console.info('[SW] blob lacks arrayBuffer; reading storage fallback', key);
          const stored = await storageGet(key).catch(() => null);
          if (stored) {
            readyMsg.cropDataUrl = stored;
            // cleanup
            await storageRemove(key).catch(() => {});
            console.info('[SW] used storage fallback for cropDataUrl', key);
          } else {
            console.warn('[SW] cropBlob not convertible to dataUrl and no storage fallback found', key);
          }
        } catch (e) {
          console.warn('[SW] Error while attempting storage fallback for crop blob', e);
        }
      }
    } catch (e) {
      console.warn('[SW] Failed to convert crop blob to dataUrl in SW', e);
    }
  }

  try { await chrome.runtime.sendMessage(readyMsg); } catch (e) { log('sending CLIPNEST_CROP_READY failed', e); }
}

// Expose function on the global scope so listeners can reliably call it even
// if module scoping changes; this prevents ReferenceError when invoked below.
try { self.handleSelection = handleSelection; } catch (e) { /* ignore */ }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('clipnest:refresh', { periodInMinutes: 15 });
});

chrome.action.onClicked.addListener(async () => {
  const tab = await getActiveTab(); if (!tab || !tab.windowId) return;
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (e) {}
  try { await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/overlay.css'] }); } catch (e) {}
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] }); } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    console.info('[SW] runtime.onMessage received', msg && msg.type, msg && msg.requestId);
  } catch (e) { /* ignore logging errors */ }
  if (!msg || msg.type !== 'CLIPNEST_SELECTION') return;
  (async () => {
    try {
  console.info('[SW] handleSelection start', msg.requestId);
  // Call the global-exposed handler to avoid ReferenceError if scoping
  // prevents the local symbol from being visible.
  if (typeof self.handleSelection === 'function') await self.handleSelection(msg);
  else await handleSelection(msg);
    } catch (e) {
      log('handleSelection uncaught', e);
      try { await chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg.requestId, message: e?.message || String(e) }); } catch (_) {}
    }
  })();
  return false;
});

// Allow the sidepanel to ask the service worker to perform the remote AI call
// (preferred for CORS and network stability). The message should be of the
// form { type: 'CLIPNEST_AI_REQUEST', requestId, page, textInRect, imageDataUrl }
chrome.runtime.onMessage.addListener(async (msg, sender) => {
  try {
    if (!msg || msg.type !== 'CLIPNEST_AI_REQUEST') return;
    const { requestId, page, textInRect, imageDataUrl } = msg;
    console.info('[SW] CLIPNEST_AI_REQUEST', requestId);
    let result = null;
    try {
      result = await remoteExplainToCard({ page, textInRect, imageDataUrl });
      // result is { card, error, details }
    } catch (e) { console.error('[SW] remoteExplainToCard threw unexpected error', e); result = { card: null, error: (e && e.message) ? e.message : String(e) }; }
    try { await chrome.runtime.sendMessage({ type: 'CLIPNEST_AI_RESPONSE', requestId, card: result?.card || null, error: result?.error || null, details: result?.details || null }); } catch (e) { console.warn('[SW] failed to send CLIPNEST_AI_RESPONSE', e); }
  } catch (e) { console.error('[SW] CLIPNEST_AI_REQUEST handler error', e); }
});

// Allow the sidepanel or UI to request LLM-generated MCQs for a given card
chrome.runtime.onMessage.addListener(async (msg, sender) => {
  try {
    if (!msg || msg.type !== 'CLIPNEST_GENERATE_MCQ') return;
    const { requestId, card } = msg;
    console.info('[SW] CLIPNEST_GENERATE_MCQ', requestId);
    let result = null;
    try {
      result = await remoteGenerateMCQ({ card });
      // result is { questions, error, details }
    } catch (e) { console.error('[SW] remoteGenerateMCQ threw unexpected error', e); result = { questions: null, error: (e && e.message) ? e.message : String(e) }; }
    try { await chrome.runtime.sendMessage({ type: 'CLIPNEST_GENERATE_MCQ_RESPONSE', requestId, questions: result?.questions || null, error: result?.error || null, details: result?.details || null }); } catch (e) { console.warn('[SW] failed to send CLIPNEST_GENERATE_MCQ_RESPONSE', e); }
  } catch (e) { console.error('[SW] CLIPNEST_GENERATE_MCQ handler error', e); }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'clipnest:refresh') return;
  try {
    const cards = await readAll();
    const due = getDueCount(cards, new Date());
    await chrome.action.setBadgeText({ text: due > 0 ? String(due) : '' });
  } catch (e) { log('alarms.onAlarm error', e); }
});


