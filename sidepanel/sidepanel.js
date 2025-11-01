import { explainToCard } from '../lib/prompt.js';
import { addCard, readAll, writeAll, updateCard, removeCard, searchCards, readSettings, updateSettings, migrateLocalToCloud, getBySubject } from '../lib/storage.js';
import { initSchedule, updateSchedule, getDue } from '../lib/scheduler.js';
import { buildTextFragmentUrl, makeId } from '../lib/utils.js';
const el = (sel) => document.querySelector(sel);
const saveBtn = () => el('#saveCardBtn');
const statusEl = () => el('#genStatus');

function setGenerating(flag, msg = '') {
  const b = saveBtn();
  if (b) { b.disabled = flag; b.textContent = flag ? 'Generating…' : 'Save card'; }
  const s = statusEl();
  if (s) s.textContent = msg;
}

function makeStubDraft() {
  // Fallback when the model isn’t ready/available
  return { subject: 'General', topic: '', tags: [], notes: 'Saved clip (no AI notes yet).', qa: [] };
}

const state = {
  current: null,
  draft: null,
  cards: []
};
state.editingId = null;
state.lastCapture = null; // store last capture params for retry
state.quiz = { queue: [], index: 0, questionIndex: 0, running: false };

function uniqueSubjects(cards) {
  const s = new Map();
  for (const c of cards) {
    const raw = (c.subject || 'General');
    const key = String(raw).trim();
    if (!s.has(key.toLowerCase())) s.set(key.toLowerCase(), key);
  }
  return Array.from(s.values()).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function populateSubjectFilter() {
  const sel = el('#subjectFilter');
  const subjects = uniqueSubjects(state.cards);
  // preserve previous selection
  const previous = (sel?.value || '').trim();
  // Build options with DOM APIs to avoid HTML encoding issues
  sel.innerHTML = '';
  const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = 'All subjects'; sel.appendChild(optAll);
  for (const s of subjects) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  // restore previous selection if still present (case-insensitive)
  if (previous) {
    const match = Array.from(sel.options).find(o => (o.value || '').toLowerCase() === previous.toLowerCase());
    if (match) sel.value = match.value; else sel.value = '';
  }
  // if settings persisted a subjectFilter, apply it (persist restore may have set value before options)
  try {
    const settings = await readSettings();
    if (settings?.subjectFilter) {
      const m = Array.from(sel.options).find(o => (o.value||'').toLowerCase() === (settings.subjectFilter||'').toLowerCase());
      if (m) sel.value = m.value;
    }
  } catch (e) { /* ignore */ }
}

async function refreshToday() {
  const selected = (el('#subjectFilter')?.value || '').trim();
  const selNorm = selected ? selected.toString().trim().toLowerCase() : '';
  // Compute due items from the in-memory state so UI updates immediately.
  const dueAll = getDue(state.cards || [], new Date());
  let due = selNorm ? dueAll.filter(c => ((c.subject || 'General') + '').toString().trim().toLowerCase() === selNorm) : dueAll;
  console.info('[sidepanel] refreshToday filter=', selNorm, 'dueAll=', dueAll.length, 'filtered=', due.length);
  const list = el('#dueList');
  list.innerHTML = '';
  for (const c of due) {
    const div = document.createElement('div'); div.className = 'cardItem';
    if (c.snippet?.type === 'image' && c.snippet.imageDataUrl) {
      const img = document.createElement('img'); img.src = c.snippet.imageDataUrl; div.appendChild(img);
    } else if (c.snippet?.text) {
      const p = document.createElement('p'); p.textContent = c.snippet.text.slice(0, 200);
      div.appendChild(p);
    }
    const title = document.createElement('div');
    title.innerHTML = `<strong>${c.subject}</strong> — ${c.topic}`;
    div.appendChild(title);
    const notes = document.createElement('div'); notes.textContent = c.notes?.short || c.notes;
    div.appendChild(notes);

    const qaWrap = document.createElement('div');
    for (const q of c.qa || []) {
      const qd = document.createElement('div'); qd.innerHTML = `<div class="q">${q.q}</div>`;
      qaWrap.appendChild(qd);
    }
    div.appendChild(qaWrap);

    const actions = document.createElement('div');
    const again = document.createElement('button'); again.textContent = 'Again';
    const good = document.createElement('button'); good.textContent = 'Good';
    again.onclick = async () => await grade(c, false);
    good.onclick  = async () => await grade(c, true);
    actions.append(again, good);
    div.appendChild(actions);

    const open = document.createElement('a');
    open.textContent = 'Open source';
    open.target = '_blank';
    open.rel = 'noopener';
    open.href = c.source?.textFragment ? buildTextFragmentUrl(c.source.url, c.source.textFragment) : (c.source?.url || '#');
    div.appendChild(open);

    list.appendChild(div);
  }
}

async function grade(card, correct) {
  card.schedule = updateSchedule(card.schedule || initSchedule(), correct, new Date());
  await writeAll(state.cards);
  await refreshToday();
}

function showExplain(draft, ctx) {
  el('#explainView').classList.remove('hidden');
  el('#cropPreview').src = ctx.cropDataUrl;

  const notes = typeof draft?.notes === 'string' ? draft.notes : (draft?.notes?.short || '');
  el('#notes').textContent = notes;

  const qaDiv = el('#qa'); qaDiv.innerHTML = '';
  (draft?.qa || []).forEach(q => {
    const d = document.createElement('div'); d.className = 'q'; d.textContent = q.q || '';
    qaDiv.appendChild(d);
  });

  el('#subjectInput').value = draft?.subject || '';
  el('#topicInput').value = draft?.topic || '';

  const sourceUrl = ctx.page?.url || '#';
  el('#openSource').href = ctx.textInRect ? buildTextFragmentUrl(sourceUrl, ctx.textInRect) : sourceUrl;
}


async function handleCropReady(ctx) {
  state.current = ctx;
  state.lastCapture = ctx; // Store for retry
  el('#explainView').classList.remove('hidden');
  setGenerating(true, 'Generating notes…');

  // Convert data URL to Blob safely (fetch(dataURL) can fail in some contexts)
  function dataUrlToBlob(dataUrl){
    if (!dataUrl || typeof dataUrl !== 'string') throw new Error('Invalid dataUrl');
    const [head, base64] = dataUrl.split(',');
    const mime = /data:(.*?);base64/.exec(head)?.[1] || 'image/webp';
    const bytes = Uint8Array.from(atob(base64 || ''), c => c.charCodeAt(0));
    return new Blob([bytes], { type: mime });
  }

  // Helper to convert Blob -> dataURL
  function blobToDataUrl(b) {
    return new Promise((resolve, reject) => {
      try {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Failed to read blob'));
        r.readAsDataURL(b);
      } catch (e) { reject(e); }
    });
  }

  let blob = null;
  // Accept either a data URL or a Blob from the background
  if (ctx.cropBlob) {
    // offscreen returned a Blob directly — use it
    blob = ctx.cropBlob;
    try { ctx.cropDataUrl = await blobToDataUrl(blob); } catch (e) { console.warn('blobToDataUrl failed', e); }
  } else if (ctx.cropDataUrl) {
    try {
      // Try fetching (handles data: and blob: URLs in many contexts)
      const resp = await fetch(ctx.cropDataUrl);
      blob = await resp.blob();
    } catch (fetchErr) {
      try {
        blob = dataUrlToBlob(ctx.cropDataUrl);
      } catch (ee) {
        console.warn('Failed to convert crop to blob', ee);
      }
    }
  } else {
    console.warn('No cropBlob or cropDataUrl provided in CLIPNEST_CROP_READY');
  }

  // Ensure preview only gets a valid data URL to avoid invalid resource requests
  try {
    const previewEl = el('#cropPreview');
    // Prefer an explicit data: URL
    if (typeof ctx.cropDataUrl === 'string' && ctx.cropDataUrl.startsWith('data:')) {
      previewEl.src = ctx.cropDataUrl;
    } else if (typeof ctx.cropDataUrl === 'string' && ctx.cropDataUrl.startsWith('blob:')) {
      // blob: URLs should be safe in the extension context
      previewEl.src = ctx.cropDataUrl;
    } else if (typeof ctx.cropDataUrl === 'string' && (ctx.cropDataUrl.startsWith('http:') || ctx.cropDataUrl.startsWith('https:'))) {
      // remote urls — attempt to use them but wrap in try/catch
      try { previewEl.src = ctx.cropDataUrl; } catch (e) { console.warn('Failed to set remote preview src', e); previewEl.src = ''; }
    } else if (ctx.cropBlob instanceof Blob) {
      // Convert Blob -> dataURL only if we truly have a Blob
      try { ctx.cropDataUrl = await blobToDataUrl(ctx.cropBlob); previewEl.src = ctx.cropDataUrl; } catch (e) { console.warn('Failed to create dataUrl for preview from blob', e); previewEl.src = ''; }
    } else if (blob instanceof Blob) {
      try { ctx.cropDataUrl = await blobToDataUrl(blob); previewEl.src = ctx.cropDataUrl; } catch (e) { console.warn('Failed to create dataUrl for preview', e); previewEl.src = ''; }
    } else {
      // If cropDataUrl is something we can't render (chrome://, undefined, file://), avoid setting it.
      console.warn('No usable crop URL or blob available for preview', { cropDataUrl: ctx.cropDataUrl, blob });
      try { previewEl.src = ''; } catch (_) {}
    }
  } catch (e) {
    console.warn('Error setting crop preview src', e);
    try { el('#cropPreview').src = ''; } catch (_) {}
  }

  let modelOut = null;
  try {
    // Prefer asking the background/service worker to perform the remote AI
    // request (more likely to succeed with proper auth/CORS). We'll send the
    // image as a data URL when available.
    const imageDataUrl = ctx.cropDataUrl || null;
    const aiRequest = { type: 'CLIPNEST_AI_REQUEST', requestId: crypto.randomUUID(), page: ctx.page, textInRect: ctx.textInRect, imageDataUrl };
    // Promise wrapper to wait for CLIPNEST_AI_RESPONSE with a timeout
    const waitForAiResponse = new Promise((resolve) => {
      let done = false;
      const onMsg = (m) => {
        try {
          if (m && m.type === 'CLIPNEST_AI_RESPONSE' && m.requestId === aiRequest.requestId) {
            done = true;
            chrome.runtime.onMessage.removeListener(onMsg);
            if (m.error) {
              console.warn('[sidepanel] AI response included error from SW:', m.error);
              // show the error in the UI briefly
              setGenerating(false, 'AI error: ' + m.error);
              resolve(null);
            } else {
              resolve(m.card || null);
            }
          }
        } catch (e) {}
      };
      chrome.runtime.onMessage.addListener(onMsg);
      // timeout fallback
      setTimeout(() => { if (!done) { chrome.runtime.onMessage.removeListener(onMsg); resolve(null); } }, 18000);
    });

    try {
      // send request (fire-and-forget) and wait for response
      chrome.runtime.sendMessage(aiRequest);
      const respCard = await waitForAiResponse;
      if (respCard) modelOut = respCard;
    } catch (e) {
      console.warn('[sidepanel] AI background request failed to send', e);
    }

    // If background did not return a card, fall back to in-context explainToCard
    if (!modelOut) {
      try {
        modelOut = await explainToCard({ page: ctx.page, textInRect: ctx.textInRect, imageBlob: blob });
      } catch (e1) {
        console.warn('[ClipNest] Multimodal prompt failed, trying text-only', e1);
        try {
          modelOut = await explainToCard({ page: ctx.page, textInRect: ctx.textInRect, imageBlob: null });
        } catch (e2) {
          console.warn('[ClipNest] Text-only prompt also failed, using stub', e2);
          modelOut = makeStubDraft();
            setGenerating(false, 'AI unavailable — saving raw clip only.');
        }
      }
    }
  } catch (e) {
    console.warn('[sidepanel] Unexpected error while requesting AI', e);
  }

  // Ensure it’s an object
  if (!modelOut || typeof modelOut !== 'object') {
    modelOut = makeStubDraft();
  }

  // Defensive normalization: ensure notes exists and is renderable for the UI.
  try {
    if (!modelOut.notes) {
      // Provide a clear fallback so users see an explanation even if the AI
      // returned an empty object or failed to produce notes.
      modelOut.notes = 'Explanation not available from the AI — saved clip only.';
    } else if (typeof modelOut.notes === 'object' && modelOut.notes.short) {
      // keep { short: '...' } shape
    } else if (typeof modelOut.notes !== 'string') {
      // coerce other types to string
      modelOut.notes = String(modelOut.notes || '');
    }
  } catch (e) {
    console.warn('[sidepanel] Failed to normalize model output', e, modelOut);
    modelOut = makeStubDraft();
  }

  console.info('[sidepanel] explainToCard output', modelOut);
  state.draft = modelOut;
  showExplain(modelOut, ctx);
  setGenerating(false, '');
}
async function saveCard() {
  // If draft isn’t ready, save a stub so the user doesn’t lose the clip.
  const d = (state.draft && typeof state.draft === 'object') ? state.draft : makeStubDraft();
  const ctx = state.current;

  const now = Date.now();
  let card;
  if (state.editingId) {
    // Update existing card
    const existing = state.cards.find(c => c.id === state.editingId) || {};
    card = {
      ...existing,
      subject: el('#subjectInput').value || d.subject || existing.subject || 'General',
      topic: el('#topicInput').value || d.topic || existing.topic || '',
      tags: Array.isArray(d.tags) ? d.tags : (existing.tags || []),
      // keep original source/snippet if editing without new crop
      source: existing.source || {
        url: ctx?.page?.url,
        title: ctx?.page?.title,
        textFragment: (ctx?.textInRect || '').slice(0, 80)
      },
      snippet: existing.snippet || {
        type: 'image', imageDataUrl: ctx?.cropDataUrl, text: ctx?.textInRect || ''
      },
      notes: typeof d.notes === 'string' ? { short: d.notes } : (d.notes || existing.notes || { short: '' }),
      qa: Array.isArray(d.qa) ? d.qa : (existing.qa || []),
      rect: ctx?.rect || existing.rect
    };
    await updateCard(card);
    state.editingId = null;
  } else {
    card = {
      id: makeId(),
      createdAt: now,
      subject: el('#subjectInput').value || d.subject || 'General',
      topic: el('#topicInput').value || d.topic || '',
      tags: Array.isArray(d.tags) ? d.tags : [],
      source: {
        url: ctx?.page?.url,
        title: ctx?.page?.title,
        textFragment: (ctx?.textInRect || '').slice(0, 80)
      },
      snippet: {
          type: 'image',
          imageDataUrl: ctx?.cropDataUrl,
          text: ctx?.textInRect || ''
        },
        // Normalize notes: always store { short, full }
        notes: (function(){
          try {
            if (typeof d.notes === 'string') return { short: d.notes, full: d.notes };
            if (!d.notes) return { short: '', full: '' };
            if (typeof d.notes === 'object') {
              const s = d.notes.short || (typeof d.notes === 'string' ? d.notes : '');
              const f = d.notes.full || (typeof d.notes === 'string' ? d.notes : (d.notes.notes || ''));
              return { short: String(s || '').slice(0,500), full: String(f || '') };
            }
            return { short: String(d.notes).slice(0,500), full: String(d.notes) };
          } catch (e) { return { short: '', full: '' }; }
        })(),
      qa: Array.isArray(d.qa) ? d.qa : [],
  // Make newly saved cards due today so they appear immediately in the
  // Today's list (users generally expect to review newly-created clips).
  // initSchedule normally sets next to today + BOX_INTERVALS[0] days; override
  // the next date to today's ISO date to make it immediately due.
  schedule: (function(){ const s = initSchedule(new Date()); s.next = new Date().toISOString().slice(0,10); return s; })(),
      stats: { seen: 0, correct: 0, incorrect: 0 },
      rect: ctx?.rect
    };

    await addCard(card);
    console.info('[sidepanel] added card', card.id);
    // If the saved card lacks an inline data URL for the image but we have a
    // crop Blob in memory, convert it and update the saved card so the UI can
    // render the image later.
    if ((!card.snippet || !card.snippet.imageDataUrl) && ctx?.cropBlob instanceof Blob) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          try {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = (e) => reject(e);
            r.readAsDataURL(ctx.cropBlob);
          } catch (e) { reject(e); }
        });
        card.snippet = card.snippet || {};
        card.snippet.imageDataUrl = dataUrl;
        await updateCard(card);
        console.info('[sidepanel] updated saved card with imageDataUrl', card.id);
      } catch (e) {
        console.warn('[sidepanel] failed to convert cropBlob for saved card', e);
      }
    }
  }
  state.cards = await readAll();
  await populateSubjectFilter();
  el('#explainView').classList.add('hidden');
  await refreshToday();
}
  
const saveCardBtnEl = el('#saveCardBtn'); if (saveCardBtnEl) saveCardBtnEl.addEventListener('click', saveCard);
const retryButtonEl = el('#retryButton'); if (retryButtonEl) retryButtonEl.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id && state.lastCapture) {
    showError('', 0); // Clear error
    await chrome.tabs.sendMessage(tab.id, { 
      type: 'CLIPNEST_START',
      rect: state.lastCapture.rect 
    });
  }
});
const todayBtnEl = el('#todayBtn'); if (todayBtnEl) todayBtnEl.addEventListener('click', () => {
  const tv = el('#todayView'); if (tv) tv.classList.remove('hidden');
  const sv = el('#settingsView'); if (sv) sv.classList.add('hidden');
});
const subjectFilterElDirect = el('#subjectFilter'); if (subjectFilterElDirect) subjectFilterElDirect.addEventListener('change', async () => { await refreshToday(); });
// Log filter changes for debugging and show result counts
const subjectFilterEl = el('#subjectFilter');
if (subjectFilterEl) subjectFilterEl.addEventListener('change', async (e) => {
  const sel = (e.target.value || '').trim();
  console.info('[sidepanel] subjectFilter changed ->', sel);
  try { await updateSettings({ subjectFilter: sel }); } catch (er) { console.debug('failed to persist subjectFilter', er); }
  await refreshToday();
  try { const dueAll = getDue(state.cards, new Date()); const filtered = sel ? dueAll.filter(c => (c.subject || 'General').toLowerCase() === sel.toLowerCase()) : dueAll; console.info('[sidepanel] refreshToday shows', (filtered || []).length, 'cards'); } catch (err) { console.warn('[sidepanel] filter debug failed', err); }
});

// Wire left navigation buttons
const clipsNav = el('#clipsNav'); if (clipsNav) clipsNav.addEventListener('click', () => { el('#manageView').classList.remove('hidden'); el('#todayView').classList.add('hidden'); el('#quizView').classList.add('hidden'); renderManageList(); });
const settingsNav = el('#settingsNav'); if (settingsNav) settingsNav.addEventListener('click', () => {
  el('#manageView').classList.add('hidden'); el('#todayView').classList.add('hidden'); el('#quizView').classList.add('hidden'); el('#settingsView').classList.remove('hidden');
});

// Ensure aiTestBtn in settings triggers the same test flow (if present)
const aiTestBtnEl = el('#aiTestBtn'); if (aiTestBtnEl) aiTestBtnEl.addEventListener('click', async () => {
  const settings = await readSettings();
  const ai = settings?.aiApi || { enabled: false, url: '', token: '' };
  if (!ai || !ai.enabled) return alert('AI not enabled. Save settings first.');
  const requestId = crypto.randomUUID();
  const page = { title: 'Test', url: location.href };
  const textInRect = 'This is a short test to verify AI integration.';
  const imageDataUrl = null;
  const aiRequest = { type: 'CLIPNEST_AI_REQUEST', requestId, page, textInRect, imageDataUrl };
  const resp = await new Promise((resolve) => {
    let done = false;
    const onMsg = (m) => {
      try {
        if (m && m.type === 'CLIPNEST_AI_RESPONSE' && m.requestId === requestId) { done = true; chrome.runtime.onMessage.removeListener(onMsg); resolve(m); }
      } catch (e) {}
    };
    chrome.runtime.onMessage.addListener(onMsg);
    setTimeout(() => { if (!done) { chrome.runtime.onMessage.removeListener(onMsg); resolve(null); } }, 20000);
    try { chrome.runtime.sendMessage(aiRequest); } catch (e) { resolve(null); }
  });
  if (!resp) return alert('No response from SW (timeout)');
  if (resp.error) return alert('AI error: ' + resp.error + '\n' + (resp.details || ''));
  alert('AI returned card: ' + JSON.stringify(resp.card || {}, null, 2));
});

// newClip button(s) used in header and side nav
const newClipBtns = Array.from(document.querySelectorAll('#newClipBtn'));
for (const nbtn of newClipBtns) if (nbtn) nbtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) {
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file://')) {
      showError('Cannot capture this page (restricted URL)', 5000, false);
      return;
    }
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (_) {}
    try { await chrome.tabs.sendMessage(tab.id, { type: 'CLIPNEST_START' }); } catch (e) {
      try { await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/overlay.css'] }); await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] }); try { await chrome.tabs.sendMessage(tab.id, { type: 'CLIPNEST_START' }); } catch (_) {} } catch (injErr) { showError('Unable to prepare the page for clipping (injection failed)', 5000, false); }
    }
  }
});
const newClipBtnSingle = el('#newClipBtn'); if (newClipBtnSingle) newClipBtnSingle.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) {
    const url = tab.url || '';
    // Avoid attempting to inject or message restricted pages (chrome://, file://, etc.)
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file://')) {
      showError('Cannot capture this page (restricted URL)', 5000, false);
      return;
    }
    await chrome.sidePanel.open({ windowId: tab.windowId });
    try {
      // Try to notify an existing content script first
      await chrome.tabs.sendMessage(tab.id, { type: 'CLIPNEST_START' });
    } catch (e) {
      // If no content script is present, attempt to inject. Wrap in try/catch
      // to surface a friendly error if injection is not permitted.
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/overlay.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] });
        // Retry sending the start message; ignore if it still fails
        try { await chrome.tabs.sendMessage(tab.id, { type: 'CLIPNEST_START' }); } catch (_) {}
      } catch (injErr) {
        console.warn('[sidepanel] injection failed', injErr);
        showError('Unable to prepare the page for clipping (injection failed)', 5000, false);
      }
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  try { console.info('[sidepanel] runtime.onMessage', msg?.type, msg?.requestId); } catch (e) {}
  if (msg?.type === 'CLIPNEST_CROP_READY') {
    console.info('[sidepanel] received CLIPNEST_CROP_READY', msg.requestId, !!msg.cropDataUrl);
    handleCropReady(msg);
    return;
  }
  if (msg?.type === 'CLIPNEST_ERROR') {
    console.warn('[sidepanel] received CLIPNEST_ERROR', msg.requestId, msg.message);
    const isRetryable = msg.message?.includes('timed out') || msg.message?.includes('chrome://');
    showError(msg.message || 'An error occurred', 5000, isRetryable);
    return;
  }
});

function showError(text, timeout = 5000, isRetryable = false) {
  const s = statusEl();
  if (!s) return alert(text);
  s.textContent = text;
  s.style.color = 'var(--danger)';
  const retryBtn = el('#retryButton');
  if (retryBtn) {
    retryBtn.classList.toggle('hidden', !isRetryable);
  }
  if (timeout > 0) {
    setTimeout(() => { 
      s.textContent = ''; 
      s.style.color = ''; 
      if (retryBtn) retryBtn.classList.add('hidden');
    }, timeout);
  }
}

(async () => {
  state.cards = await readAll();
  // load settings and apply UI
  try {
    const settings = await readSettings();
    const useMock = !!settings.useMock;
    const chk = el('#useMockToggle'); if (chk) chk.checked = useMock;
    // theme
  const theme = settings?.theme || 'light';
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  const themeChk = el('#themeToggle'); if (themeChk) themeChk.checked = (theme === 'dark');
  // restore persisted subject filter selection (if set previously)
  try { const persisted = settings?.subjectFilter || ''; if (persisted && el('#subjectFilter')) el('#subjectFilter').value = persisted; } catch (e) { console.debug('failed to restore subjectFilter', e); }
    // cloud settings (if present)
    const cloud = settings?.cloud || { enabled: false, url: '', token: '' };
    const cloudEnable = el('#cloudEnable'); if (cloudEnable) cloudEnable.checked = !!cloud.enabled;
    const cloudUrl = el('#cloudUrl'); if (cloudUrl) cloudUrl.value = cloud.url || '';
    const cloudToken = el('#cloudToken'); if (cloudToken) cloudToken.value = cloud.token || '';
    const cloudSaveBtn = el('#cloudSaveBtn');
    const cloudMigrateBtn = el('#cloudMigrateBtn');
    if (cloudSaveBtn) cloudSaveBtn.addEventListener('click', async () => {
      const enabled = !!(el('#cloudEnable')?.checked);
      const url = (el('#cloudUrl')?.value || '').trim();
      const token = (el('#cloudToken')?.value || '').trim();
      await updateSettings({ cloud: { enabled, url, token } });
      alert('Cloud settings saved');
    });
    if (cloudMigrateBtn) cloudMigrateBtn.addEventListener('click', async () => {
      try {
        cloudMigrateBtn.disabled = true;
        const merged = await migrateLocalToCloud();
        // refresh local state
  state.cards = await readAll();
  await populateSubjectFilter();
        await refreshToday();
        alert('Migration complete — ' + (merged?.length || 0) + ' cards');
      } catch (e) {
        console.error('Migration failed', e);
        alert('Migration failed: ' + (e?.message || String(e)));
      } finally { if (cloudMigrateBtn) cloudMigrateBtn.disabled = false; }
    });
    // AI API settings
    const ai = settings?.aiApi || { enabled: false, url: '', token: '' };
    const aiEnable = el('#aiEnable'); if (aiEnable) aiEnable.checked = !!ai.enabled;
    const aiUrl = el('#aiUrl'); if (aiUrl) aiUrl.value = ai.url || '';
    const aiToken = el('#aiToken'); if (aiToken) aiToken.value = ai.token || '';
    const aiSaveBtn = el('#aiSaveBtn');
    if (aiSaveBtn) aiSaveBtn.addEventListener('click', async () => {
      const enabled = !!(el('#aiEnable')?.checked);
      const url = (el('#aiUrl')?.value || '').trim();
      const token = (el('#aiToken')?.value || '').trim();
      await updateSettings({ aiApi: { enabled, url, token } });
      alert('AI settings saved');
    });
    // Add a simple Test AI button to exercise the SW path
    const aiTestBtn = document.createElement('button');
    aiTestBtn.textContent = 'Test AI'; aiTestBtn.style.marginLeft = '8px';
    aiSaveBtn?.parentElement?.appendChild(aiTestBtn);
    aiTestBtn.addEventListener('click', async () => {
      const settings = await readSettings();
      const ai = settings?.aiApi || { enabled: false, url: '', token: '' };
      if (!ai || !ai.enabled) return alert('AI not enabled. Save settings first.');
      const requestId = crypto.randomUUID();
      const page = { title: 'Test', url: location.href };
      const textInRect = 'This is a short test to verify AI integration.';
      const imageDataUrl = null;
      const aiRequest = { type: 'CLIPNEST_AI_REQUEST', requestId, page, textInRect, imageDataUrl };
      const resp = await new Promise((resolve) => {
        let done = false;
        const onMsg = (m) => {
          try {
            if (m && m.type === 'CLIPNEST_AI_RESPONSE' && m.requestId === requestId) {
              done = true; chrome.runtime.onMessage.removeListener(onMsg); resolve(m); }
          } catch (e) {}
        };
        chrome.runtime.onMessage.addListener(onMsg);
        setTimeout(() => { if (!done) { chrome.runtime.onMessage.removeListener(onMsg); resolve(null); } }, 20000);
        try { chrome.runtime.sendMessage(aiRequest); } catch (e) { resolve(null); }
      });
      if (!resp) return alert('No response from SW (timeout)');
      if (resp.error) return alert('AI error: ' + resp.error + '\n' + (resp.details || ''));
      alert('AI returned card: ' + JSON.stringify(resp.card || {}, null, 2));
    });
  } catch (e) { console.debug('Could not load settings', e); }
  await populateSubjectFilter();
  await refreshToday();
})();

// persist mock toggle
const mockToggle = el('#useMockToggle');
if (mockToggle) mockToggle.addEventListener('change', async (e) => {
  await updateSettings({ useMock: !!e.target.checked });
});
const themeToggle = el('#themeToggle');
if (themeToggle) themeToggle.addEventListener('change', async (e) => {
  const dark = !!e.target.checked;
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  await updateSettings({ theme: dark ? 'dark' : 'light' });
});

// --- Quiz logic ---
async function startQuiz() {
  // If a card is currently open, quiz that card only.
  if (state.current && state.draft && state.draft.subject) {
    // Find the saved card matching the open item (if saved) otherwise build a temp card
    const openCard = state.cards.find(c => c.id === state.editingId) || null;
    if (openCard) {
      state.quiz.queue = [openCard];
    } else {
      // not saved — create a transient quiz item from draft + current context
      const transient = {
        id: 'transient',
        subject: state.draft.subject || 'General',
        topic: state.draft.topic || '',
        snippet: { imageDataUrl: state.current.cropDataUrl, text: state.current.textInRect || '' },
        notes: { short: (typeof state.draft.notes === 'string' ? state.draft.notes : (state.draft.notes?.short || '')) },
        qa: Array.isArray(state.draft.qa) ? state.draft.qa : []
      };
      state.quiz.queue = [transient];
    }
  } else {
    // Build a mixed queue from due cards (getDue already interleaves by subject)
    const due = getDue(state.cards, new Date());
    if (!due.length) return alert('No cards due for review right now.');
  state.quiz.queue = due;
  }
  state.quiz.index = 0;
  state.quiz.questionIndex = 0;
  state.quiz.running = true;
  // show quiz view
  el('#quizView').classList.remove('hidden');
  el('#todayView').classList.add('hidden');
  // Ensure inline answer display exists and is cleared
  if (!el('#quizAnswerDisplay')) {
    const d = document.createElement('div'); d.id = 'quizAnswerDisplay'; d.style.marginTop = '8px'; d.className = 'hidden';
    el('#quizView').appendChild(d);
  }
  const disp = el('#quizAnswerDisplay'); if (disp) { disp.textContent = ''; disp.classList.add('hidden'); }
  // Attempt to generate MCQs for the queued cards (for saved cards only)
  try {
    // only request for saved cards with an id
    const toGenerate = state.quiz.queue.filter(c => c.id && c.id !== 'transient');
    if (toGenerate.length) {
      // For each saved card, request a single-card MCQ with 3 distractors and persist to storage
      for (const c of toGenerate.slice(0, 12)) {
        try {
          const requestId = crypto.randomUUID();
          const payload = { type: 'CLIPNEST_GENERATE_MCQ_CARD', requestId, card: { id: c.id, subject: c.subject, topic: c.topic, notes: c.notes, snippet: c.snippet } };
          const resp = await new Promise((resolve) => {
            let done = false;
            const onMsg = (m) => {
              try {
                if (m && m.type === 'CLIPNEST_GENERATE_MCQ_CARD_RESPONSE' && m.requestId === requestId) {
                  done = true; chrome.runtime.onMessage.removeListener(onMsg); resolve(m);
                }
              } catch (e) {}
            };
            chrome.runtime.onMessage.addListener(onMsg);
            setTimeout(() => { if (!done) { chrome.runtime.onMessage.removeListener(onMsg); resolve(null); } }, 25000);
            try { chrome.runtime.sendMessage(payload); } catch (e) { resolve(null); }
          });
          if (resp && resp.question && resp.question.q) {
            // attach to in-memory card and persist
            const idx = state.cards.findIndex(x => x.id === c.id);
            const qaEntry = { q: resp.question.q, a: resp.question.a, choices: resp.question.choices || [] };
            if (idx >= 0) {
              state.cards[idx].qa = state.cards[idx].qa || [];
              state.cards[idx].qa.unshift(qaEntry);
              try { await updateCard(state.cards[idx]); } catch (e) { console.debug('failed to persist generated mcq', e); }
              // also update queue copy
              const qidx = state.quiz.queue.findIndex(x => x.id === c.id); if (qidx >= 0) state.quiz.queue[qidx].qa = state.cards[idx].qa;
            }
          }
        } catch (e) { console.debug('card mcq generation failed', e); }
      }
    }
  } catch (e) { console.debug('MCQ generation request failed', e); }

  showQuizItem();
}

function stopQuiz() {
  state.quiz.running = false;
  el('#quizView').classList.add('hidden');
  el('#todayView').classList.remove('hidden');
}

function showQuizItem() {
  const qIdx = state.quiz.index;
  if (qIdx >= state.quiz.queue.length) {
    alert('Quiz complete — good job!');
    stopQuiz();
    return;
  }
  const card = state.quiz.queue[qIdx];
  const qList = (card.qa || []);
  const question = qList[state.quiz.questionIndex] || qList[0] || null;

  el('#quizCard').innerHTML = card.snippet?.imageDataUrl ? `<img src="${card.snippet.imageDataUrl}" style="width:200px;border-radius:6px;" />` : '';
  el('#quizQuestion').textContent = question ? (question.q || '') : 'Explain this snippet';
  el('#quizAnswer').value = '';
  el('#quizAnswer').focus();

  // Render MCQ choices if present or synthesize simple choices from content
  const choicesWrap = el('#quizChoices');
  choicesWrap.innerHTML = '';
  let choices = [];
  if (question && question.choices && question.choices.length) {
    choices = question.choices;
  } else if (question && question.a) {
    // Create simple MCQ: correct answer + 3 distractors by truncating/reshaping
    const correct = (question.a || '').slice(0, 140);
    const d1 = correct.split(' ').slice(0,6).join(' ');
    const d2 = correct.split(' ').slice(1,7).join(' ');
    const d3 = (correct.length > 30) ? correct.slice(0,30) + '…' : ('Related: ' + (card.topic || card.subject || ''));
    choices = [correct, d1 || 'None', d2 || 'None', d3 || 'None'];
  }
  // shuffle choices
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  // render buttons
  choices.forEach((c, idx) => {
    const btn = document.createElement('button'); btn.textContent = c; btn.dataset.idx = idx;
    btn.addEventListener('click', async () => {
      // determine correctness: if question.a exists, compare trimmed
      const correctAnswer = (question && question.a) ? String(question.a).trim() : null;
      const chosen = String(c).trim();
      const isCorrect = correctAnswer ? (chosen === String(correctAnswer).trim()) : false;
      if (isCorrect) {
        btn.style.borderColor = 'green';
        await gradeQuiz(true);
      } else {
        btn.style.borderColor = 'orange';
        await gradeQuiz(false);
      }
    });
    choicesWrap.appendChild(btn);
  });
}

async function gradeQuiz(correct) {
  const card = state.quiz.queue[state.quiz.index];
  if (!card) return;
  // update schedule & stats
  card.schedule = updateSchedule(card.schedule || initSchedule(), !!correct, new Date());
  card.stats = card.stats || { seen: 0, correct: 0, incorrect: 0 };
  card.stats.seen = (card.stats.seen || 0) + 1;
  if (correct) card.stats.correct = (card.stats.correct || 0) + 1; else card.stats.incorrect = (card.stats.incorrect || 0) + 1;

  // persist changes back into state.cards
  const idx = state.cards.findIndex(c => c.id === card.id);
  if (idx >= 0) state.cards[idx] = card;
  await writeAll(state.cards);

  // move to next card only when user marked Good. If user clicked Again,
  // repeat the same card (don't advance the queue) so they can retry.
  if (correct) {
    state.quiz.index++;
    state.quiz.questionIndex = 0;
  }
  showQuizItem();
}

// Buttons
const quizBtnEl = el('#quizBtn'); if (quizBtnEl) quizBtnEl.addEventListener('click', () => startQuiz());
const quizQuitEl = el('#quizQuit'); if (quizQuitEl) quizQuitEl.addEventListener('click', () => stopQuiz());
const quizRevealEl = el('#quizReveal'); if (quizRevealEl) quizRevealEl.addEventListener('click', () => {
  const card = state.quiz.queue[state.quiz.index];
  const qList = (card?.qa || []);
  const question = qList[state.quiz.questionIndex] || qList[0] || { q: '', a: card?.notes?.short || '' };
  // Show the answer inline in the quiz area instead of using alert()
  const disp = el('#quizAnswerDisplay');
  if (disp) { disp.textContent = `Answer: ${question.a || '(no answer provided)'}`; disp.classList.remove('hidden'); }
  // if MCQ buttons present, highlight the correct one
  try {
    const correct = question?.a ? String(question.a).trim() : null;
    if (correct) {
      const btns = Array.from(document.querySelectorAll('#quizChoices button'));
      btns.forEach(b => { if (String(b.textContent).trim() === correct) b.style.borderColor = 'green'; });
    }
  } catch (e) { /* ignore */ }
});
const quizAgainEl = el('#quizAgain'); if (quizAgainEl) quizAgainEl.addEventListener('click', async () => await gradeQuiz(false));
const quizGoodEl = el('#quizGood'); if (quizGoodEl) quizGoodEl.addEventListener('click', async () => await gradeQuiz(true));

// --- Manage view & search / edit / delete ---
const cardSearchEl = el('#cardSearch'); if (cardSearchEl) cardSearchEl.addEventListener('input', async (e) => {
  const q = e.target.value || '';
  if (!q) return renderManageList();
  const results = await searchCards(q);
  renderManageList(results);
});
const manageBtnEl = el('#manageBtn'); if (manageBtnEl) manageBtnEl.addEventListener('click', () => {
  const mv = el('#manageView');
  const tv = el('#todayView');
  if (mv && mv.classList.contains('hidden')) {
    mv.classList.remove('hidden');
    if (tv) tv.classList.add('hidden');
    renderManageList();
  } else if (mv) {
    mv.classList.add('hidden');
    if (tv) tv.classList.remove('hidden');
  }
});

// Menu dropdown behavior
const menuBtn = el('#menuBtn');
const menuDropdown = el('#menuDropdown');
if (menuBtn && menuDropdown) {
  menuBtn.addEventListener('click', (e) => {
    menuDropdown.classList.toggle('hidden');
  });
  // close when clicking outside
  document.addEventListener('click', (e) => {
    if (!menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.classList.add('hidden');
  });
}

// header menu settings button
const menuSettingsBtn = el('#menuSettingsBtn'); if (menuSettingsBtn) menuSettingsBtn.addEventListener('click', () => { menuDropdown.classList.add('hidden'); settingsNav?.click?.(); });
// wire other menu items (use unique IDs to avoid collisions with sidebar buttons)
const menuToday = el('#menu-todayBtn'); if (menuToday) menuToday.addEventListener('click', () => { menuDropdown.classList.add('hidden'); el('#todayView').classList.remove('hidden'); el('#manageView').classList.add('hidden'); el('#quizView').classList.add('hidden'); });
const menuQuiz = el('#menu-quizBtn'); if (menuQuiz) menuQuiz.addEventListener('click', () => { menuDropdown.classList.add('hidden'); startQuiz(); });
const menuManage = el('#menu-manageBtn'); if (menuManage) menuManage.addEventListener('click', () => { menuDropdown.classList.add('hidden'); renderManageList(); el('#manageView').classList.remove('hidden'); el('#todayView').classList.add('hidden'); el('#quizView').classList.add('hidden'); });

function renderManageList(list) {
  const out = list || state.cards || [];
  const wrap = el('#manageList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!out.length) { wrap.textContent = 'No cards found.'; return; }
  for (const c of out) {
    const d = document.createElement('div'); d.className = 'cardItem';
    const h = document.createElement('div'); h.innerHTML = `<strong>${c.subject}</strong> — ${c.topic}`;
    d.appendChild(h);
    const p = document.createElement('div'); p.textContent = c.notes?.short || c.notes || '';
    d.appendChild(p);
    const btns = document.createElement('div'); btns.className = 'actions';
    const edit = document.createElement('button'); edit.textContent = 'Edit';
    const del = document.createElement('button'); del.textContent = 'Delete';
    edit.onclick = () => openEditCard(c.id);
    del.onclick = async () => {
      if (!confirm('Delete this card?')) return;
  await removeCard(c.id);
  state.cards = await readAll();
  await populateSubjectFilter();
      renderManageList();
      await refreshToday();
    };
    btns.append(edit, del);
    d.appendChild(btns);
    wrap.appendChild(d);
  }
}

function openEditCard(cardId) {
  const c = state.cards.find(x => x.id === cardId);
  if (!c) return alert('Card not found');
  state.editingId = c.id;
  state.draft = { subject: c.subject, topic: c.topic, tags: c.tags, notes: c.notes?.short || (c.notes || ''), qa: c.qa };
  state.current = { cropDataUrl: c.snippet?.imageDataUrl || '', page: c.source, textInRect: c.snippet?.text || '', rect: c.rect };
  showExplain(state.draft, state.current);
}
