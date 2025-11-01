// lib/prompt.js
import { readSettings, writeDebugResponse } from './storage.js';

function truncateText(s, max = 1600) {
  if (!s) return '';
  const t = String(s || '');
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n[truncated]';
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('prompt-timeout')), ms))
  ]);
}

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

// Helper: fetch with retries and exponential backoff. Respects Retry-After header
// when present (in seconds) and retries on network errors or 429/503.
async function fetchWithRetries(url, options = {}, maxAttempts = 6) {
  // Use a slightly larger base delay and more attempts to tolerate
  // transient 429/503 rate limits from providers. Cap the backoff so
  // retries don't wait excessively long in the extension.
  const baseDelay = 1000; // ms
  const maxDelay = 15000; // ms
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok) return resp;
      // If rate-limited, respect Retry-After if provided
      if (resp.status === 429 || resp.status === 503) {
        const ra = resp.headers.get('Retry-After');
        let waitMs = 0;
        if (ra) {
          const v = parseInt(ra, 10);
          if (!Number.isNaN(v)) waitMs = v * 1000;
        }
        if (!waitMs) {
          // exponential backoff with jitter, capped
          waitMs = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 800);
        }
        console.warn(`fetchWithRetries: attempt ${attempt} got ${resp.status}, retrying after ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      // Non-retryable status — return response for caller to inspect
      return resp;
    } catch (e) {
      // network/error — retry with backoff unless last attempt
      if (attempt === maxAttempts) throw e;
      const waitMs = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 800);
      console.warn(`fetchWithRetries network error on attempt ${attempt}, retrying in ${waitMs}ms`, e);
      await sleep(waitMs);
    }
  }
  throw new Error('fetchWithRetries exhausted');
}

export async function createSession({ wantsImage }) {
  // Prepare modalities per docs. Only 'en', 'ja', 'es' are currently supported for outputs.
  // Multimodal (image/audio) may not be available in Stable; guard and fall back.
  const expectedInputs = wantsImage
    ? [{ type: 'text', languages: ['en'] }, { type: 'image', languages: ['en'] }]
    : [{ type: 'text', languages: ['en'] }];
  const expectedOutputs = [{ type: 'text', languages: ['en'] }];

  let availability = 'unavailable';
  try {
    availability = await LanguageModel.availability({ expectedInputs, expectedOutputs });
  } catch (e) {
    // API missing or modalities not supported
    availability = 'unavailable';
  }
  if (availability === 'unavailable') {
    // Try text-only as fallback
    if (wantsImage) {
      return createSession({ wantsImage: false });
    }
    throw new Error('Model unavailable');
  }

  const session = await LanguageModel.create({
    expectedInputs,
    expectedOutputs,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        // You can surface e.loaded (0..1) to the UI if desired.
        console.debug('Model download', e.loaded);
      });
    }
  });

  return { session, multimodal: wantsImage };
}

export const CARD_SCHEMA = {
  type: 'object',
  required: ['subject', 'topic', 'notes', 'qa', 'tags'],
  properties: {
    subject: { type: 'string', maxLength: 40 },
    topic:   { type: 'string', maxLength: 80 },
    tags:    { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 24 } },
    notes:   { type: 'string', maxLength: 500 },
    qa:      {
      type: 'array', maxItems: 3,
      items: {
        type: 'object',
        required: ['type', 'q', 'a'],
        properties: {
          type: { enum: ['mcq', 'short', 'cloze'] },
          q:    { type: 'string', maxLength: 140 },
          a:    { type: 'string', maxLength: 140 },
          choices: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 80 } }
        }
      }
    }
  }
};

export async function explainToCard({ page, textInRect, imageBlob }) {
  // Check settings: allow forcing mock AI for developer/testing
  try {
    const settings = await readSettings();
    if (settings?.useMock) return mockExplainToCard(page, textInRect, imageBlob);
  } catch (e) {
    // ignore settings read errors and continue
    console.debug('Could not read settings', e);
  }

  // Prefer calling a configured remote AI API (if present) rather than an
  // on-device model. The API should accept either JSON (text-only) or a
  // multipart/form-data payload when an image is supplied, and return a
  // JSON object representing the card (or { card: { ... } }).
  try {
    const settings = await readSettings().catch(() => ({}));
    const ai = settings?.aiApi;
    console.debug('[prompt] explainToCard ai settings:', ai);
    if (ai && ai.enabled && ai.url) {
  // If a caller in an extension context prefers the service worker to
  // perform the network request (better CORS/network privileges), callers
  // can alternatively invoke `remoteExplainToCard` from the background
  // or request the background via messaging. The rest of this function
  // retains the in-context fallback for non-extension hosts.
      const controller = new AbortController();
  // Increase in-context timeout to allow for retries/backoff
  const timeoutMs = 60000;
      const to = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = ai.token ? { Authorization: 'Bearer ' + ai.token } : {};

        // If the user configured a Cohere endpoint (ai.url === 'cohere' or contains 'cohere.ai'),
        // call Cohere's generate API and try to parse the generated text as JSON.
        if (ai.url === 'cohere' || (typeof ai.url === 'string' && ai.url.includes('cohere.ai'))) {
          let imageDataUrl = null;
          if (imageBlob) {
            imageDataUrl = await new Promise((resolve) => {
              try {
                const r = new FileReader();
                r.onload = () => resolve(r.result);
                r.onerror = () => resolve(null);
                r.readAsDataURL(imageBlob);
              } catch (e) { resolve(null); }
            });
          }

          const system = `You are a concise study coach. Given the page metadata, an optional small image (as a data URL), and extracted text, produce a JSON object with keys: subject, topic, tags (array), notes (string). The notes field should be a clear, concise explanatory summary of the clip — do not ask questions or generate quiz items. Set 'qa' to an empty array. Respond with raw JSON only.`;
          const user = `Page: ${page.title || ''}\nURL: ${page.url || ''}\nText:\n${truncateText(textInRect) || '(none)'}\n` + (imageDataUrl ? `\nImageDataUrl: ${imageDataUrl}\n` : '');

          const cohereBody = {
            model: 'command-xlarge-nightly',
            prompt: system + '\n' + user + '\nReturn only JSON.',
            max_tokens: 400,
            temperature: 0.2
          };
          // Use Cohere's documented v1 endpoint
          const cohereUrl = 'https://api.cohere.ai/v1/generate';
          console.debug('[prompt] calling Cohere URL', cohereUrl);
          const resp = await fetchWithRetries(cohereUrl, { method: 'POST', body: JSON.stringify(cohereBody), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 3);
          clearTimeout(to);
          if (!resp.ok) {
            console.warn('Cohere API returned non-OK status', resp.status);
          } else {
            const json = await resp.json();
            const textOut = (json?.generations && json.generations[0]?.text)
              || (json?.output && json.output[0]?.content)
              || json?.text
              || '';
            const trimmed = (textOut || '').trim();
            const m = trimmed.match(/\{[\s\S]*\}/);
            const jsonText = m ? m[0] : trimmed;
            try {
              const card = JSON.parse(jsonText);
              if (card && typeof card === 'object') return card;
            } catch (e) {
              console.warn('Failed to parse Cohere output as JSON', e);
            }
          }
        } else if (ai.url === 'openai' || (typeof ai.url === 'string' && ai.url.includes('openai.com'))) {
          // OpenAI Responses API
          try {
            // For OpenAI, avoid embedding large base64 image payloads in the prompt
            // (they can exceed the model context). Use truncated text instead.
            const system = `You are a concise study coach. Given the page metadata and extracted text, produce a JSON object with keys: subject, topic, tags (array), notes (string). The notes field should be a clear, concise explanatory summary of the clip  do not ask questions or generate quiz items. Set 'qa' to an empty array. Respond with raw JSON only.`;
            const user = `Page: ${page.title || ''}\nURL: ${page.url || ''}\nText:\n${truncateText(textInRect) || '(none)'}\n`;
            const prompt = system + '\n' + user + '\nReturn only JSON.';

            const model = ai.model || 'gpt-4o-mini';
            const body = { model, input: prompt };
            const openaiUrl = 'https://api.openai.com/v1/responses';
            console.debug('[prompt] calling OpenAI Responses API', openaiUrl, 'model', model);
            const resp = await fetchWithRetries(openaiUrl, { method: 'POST', body: JSON.stringify(body), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 3);
            clearTimeout(to);
            if (!resp.ok) {
              // Log response body to help debugging (don't log auth headers)
              let bodyText = '';
              try { bodyText = await resp.text(); } catch (e) { bodyText = '<unreadable>'; }
              console.warn('OpenAI Responses API returned non-OK status', resp.status, bodyText);
            } else {
              const json = await resp.json();
              // Extract text from a few known response shapes
              let textOut = '';
              if (json?.output && Array.isArray(json.output)) {
                textOut = json.output.map(o => (o.content || []).map(c => c.text || '').join('')).join('\n');
              } else if (json?.choices && Array.isArray(json.choices)) {
                const c0 = json.choices[0];
                if (c0?.message?.content) {
                  if (typeof c0.message.content === 'string') textOut = c0.message.content;
                  else if (Array.isArray(c0.message.content)) textOut = c0.message.content.map(c => c.text || '').join('');
                } else if (c0?.text) textOut = c0.text;
              } else if (typeof json === 'string') textOut = json;

              const trimmed = (textOut || '').trim();
              const m = trimmed.match(/\{[\s\S]*\}/);
              const jsonText = m ? m[0] : trimmed;
              try {
                const card = JSON.parse(jsonText);
                if (card && typeof card === 'object') return card;
              } catch (e) {
                console.warn('Failed to parse OpenAI output as JSON', e);
                console.debug('OpenAI output (trimmed):', trimmed.slice(0, 2000));
                console.debug('OpenAI extracted jsonText (first 2000 chars):', jsonText.slice(0, 2000));
              }
            }
          } catch (e) {
            console.warn('OpenAI API call failed', e);
          }
        } else {
          // Generic remote API path: respect ai.url and allow multipart when image present
          let resp;
          if (imageBlob) {
            const form = new FormData();
            form.append('page', JSON.stringify(page || {}));
            form.append('text', textInRect || '');
            form.append('image', imageBlob, 'clip.png');
            console.debug('[prompt] calling generic AI API (multipart) ->', ai.url);
            resp = await fetchWithRetries(ai.url, { method: 'POST', body: form, headers, signal: controller.signal }, 3);
          } else {
            console.debug('[prompt] calling generic AI API (json) ->', ai.url);
            resp = await fetchWithRetries(ai.url, { method: 'POST', body: JSON.stringify({ page, text: textInRect || '' }), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 3);
          }
          clearTimeout(to);
          if (resp && resp.ok) {
            const json = await resp.json();
            const card = json?.card || json;
            if (card && typeof card === 'object') return card;
          } else {
            console.warn('AI API returned non-OK status', resp && resp.status);
          }
        }
      } catch (e) {
        console.warn('AI API call failed', e);
      } finally {
        try { clearTimeout(to); } catch (_) {}
      }
    }
  } catch (e) {
    console.debug('Error while attempting AI API call', e);
  }

  // No remote API or it failed — fall back to the lightweight mock.
  return mockExplainToCard(page, textInRect, imageBlob);
}

// Export a helper that performs only the remote AI call and returns a parsed
// card object or null. This is safe to call from the service worker where
// CORS and network policies are more permissive than extension UI pages.
export async function remoteExplainToCard({ page = {}, textInRect = '', imageDataUrl = null, aiOverride = null } = {}) {
  const result = { card: null, error: null };
  try {
    const settings = await readSettings().catch(() => ({}));
    const ai = aiOverride || settings?.aiApi;
    if (!ai || !ai.enabled || !ai.url) { result.error = 'ai-not-configured'; return result; }

    const controller = new AbortController();
  // Allow a longer timeout to accommodate multiple retry backoffs
  const timeoutMs = 60000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = ai.token ? { Authorization: 'Bearer ' + ai.token } : {};
      let rateLimitCount = 0;

      if (ai.url === 'cohere' || (typeof ai.url === 'string' && ai.url.includes('cohere.ai'))) {
        const system = `You are a concise study coach. Given the page metadata, an optional small image (as a data URL), and extracted text, produce a JSON object with keys: subject, topic, tags (array), notes (string). The notes field should be a clear, concise explanatory summary of the clip \u2014 do not ask questions or generate quiz items. Set 'qa' to an empty array. Respond with raw JSON only.`;
        const user = `Page: ${page.title || ''}\nURL: ${page.url || ''}\nText:\n${truncateText(textInRect) || '(none)'}\n` + (imageDataUrl ? `\nImageDataUrl: ${imageDataUrl}\n` : '');

        const cohereBody = {
          model: 'command-xlarge-nightly',
          prompt: system + '\n' + user + '\nReturn only JSON.',
          max_tokens: 400,
          temperature: 0.2
        };
        const cohereUrl = 'https://api.cohere.ai/v1/generate';
        const resp = await fetchWithRetries(cohereUrl, { method: 'POST', body: JSON.stringify(cohereBody), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 3);
        clearTimeout(to);
        // Save debug body if requested
        try {
          if (settings?.debugAiResponses) {
            const bodyText = await resp.text().catch(() => '<unreadable>');
            await writeDebugResponse({ provider: 'cohere', status: resp.status, body: bodyText, time: Date.now() });
          }
        } catch (_) {}
        if (!resp.ok) { result.error = `cohere-non-ok:${resp.status}`; try { result.details = await resp.text(); } catch(_){}; return result; }
        const json = await resp.json();
        const textOut = (json?.generations && json.generations[0]?.text) || (json?.output && json.output[0]?.content) || json?.text || '';
        const trimmed = (textOut || '').trim();
        const m = trimmed.match(/\{[\s\S]*\}/);
        const jsonText = m ? m[0] : trimmed;
        try { const card = JSON.parse(jsonText); if (card && typeof card === 'object') return card; } catch (e) { return null; }
      }

      if (ai.url === 'openai' || (typeof ai.url === 'string' && ai.url.includes('openai.com'))) {
        // For OpenAI avoid embedding large image base64 in the prompt and
        // truncate text to stay within context limits.
        const system = `You are a concise study coach. Given the page metadata and extracted text, produce a JSON object with keys: subject, topic, tags (array), notes (string). The notes field should be a clear, concise explanatory summary of the clip \u2014 do not ask questions or generate quiz items. Set 'qa' to an empty array. Respond with raw JSON only.`;
        const user = `Page: ${page.title || ''}\nURL: ${page.url || ''}\nText:\n${truncateText(textInRect) || '(none)'}\n`;
        const prompt = system + '\n' + user + '\nReturn only JSON.';
        const model = ai.model || 'gpt-4o-mini';
        const body = { model, input: prompt };
        const openaiUrl = 'https://api.openai.com/v1/responses';
        const resp = await fetchWithRetries(openaiUrl, { method: 'POST', body: JSON.stringify(body), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 6);
        clearTimeout(to);
        if (!resp.ok) {
          // Save the response body if debug is enabled
          try {
            const dbg = await readSettings().catch(() => ({}));
            if (dbg?.debugAiResponses) {
              const bodyText = await resp.text().catch(() => '<unreadable>');
              await writeDebugResponse({ provider: 'openai', status: resp.status, body: bodyText, time: Date.now() });
            }
          } catch (_) {}
          // If rate-limited, mark and possibly fall back below
          if (resp.status === 429) { rateLimitCount++; }
          result.error = `openai-non-ok:${resp.status}`;
          try { result.details = await resp.text(); } catch(_){}
          // Let the caller inspect result; we also continue to allow fallback
          return result;
        }
        const json = await resp.json();
        let textOut = '';
        if (json?.output && Array.isArray(json.output)) {
          textOut = json.output.map(o => (o.content || []).map(c => c.text || '').join('')).join('\n');
        } else if (json?.choices && Array.isArray(json.choices)) {
          const c0 = json.choices[0];
          if (c0?.message?.content) {
            if (typeof c0.message.content === 'string') textOut = c0.message.content;
            else if (Array.isArray(c0.message.content)) textOut = c0.message.content.map(c => c.text || '').join('');
          } else if (c0?.text) textOut = c0.text;
        } else if (typeof json === 'string') textOut = json;
        const trimmed = (textOut || '').trim();
        const m = trimmed.match(/\{[\s\S]*\}/);
        const jsonText = m ? m[0] : trimmed;
        try { const card = JSON.parse(jsonText); if (card && typeof card === 'object') return card; } catch (e) { return null; }
      }

      // Generic remote API path (JSON or multipart). Accepts page/text and
      // optional imageDataUrl. The server should return the card object or {card:...}.
      if (imageDataUrl) {
        // send as JSON with image data (simpler than multipart in worker); still
        // truncate the text we send to any custom endpoint to reduce size.
        const resp = await fetchWithRetries(ai.url, { method: 'POST', body: JSON.stringify({ page, text: truncateText(textInRect) || '', imageDataUrl }), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 6);
        clearTimeout(to);
        try {
          if (settings?.debugAiResponses) {
            const bodyText = await resp.text().catch(() => '<unreadable>');
            await writeDebugResponse({ provider: 'remote', status: resp.status, body: bodyText, time: Date.now() });
          }
        } catch (_) {}
        if (!resp.ok) { if (resp.status === 429) rateLimitCount++; result.error = `remote-non-ok:${resp.status}`; try { result.details = await resp.text(); } catch(_){}; return result; }
        const json = await resp.json();
        const card = json?.card || json;
        if (card && typeof card === 'object') return card;
      } else {
        const resp = await fetchWithRetries(ai.url, { method: 'POST', body: JSON.stringify({ page, text: truncateText(textInRect) || '' }), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 6);
        clearTimeout(to);
        try {
          if (settings?.debugAiResponses) {
            const bodyText = await resp.text().catch(() => '<unreadable>');
            await writeDebugResponse({ provider: 'remote', status: resp.status, body: bodyText, time: Date.now() });
          }
        } catch (_) {}
        if (!resp.ok) { if (resp.status === 429) rateLimitCount++; result.error = `remote-non-ok:${resp.status}`; try { result.details = await resp.text(); } catch(_){}; return result; }
        const json = await resp.json();
        const card = json?.card || json;
        if (card && typeof card === 'object') return card;
      }
    } catch (e) {
          try { clearTimeout(to); } catch (_) {}
          result.error = (e && e.message) ? e.message : String(e);
          // If we exhausted retries due to rate limits, return a clear code
          if (result.error && result.error.toLowerCase().includes('fetchwithretries exhausted')) {
            result.error = 'rate-limited';
          }
          // If rate limits were observed, return a helpful sentinel so the SW
          // caller can either retry later or fall back. We'll return result here
          // which the SW will forward to the UI; the UI can then optionally
          // call mockExplainToCard locally.
          return result;
    } finally {
      try { clearTimeout(to); } catch (_) {}
    }
  } catch (e) {
    result.error = (e && e.message) ? e.message : String(e);
    return result;
  }
      // If we reach this point without returning a card, but we detected rate
      // limiting repeatedly, return a mock card so the user flow continues.
      if (result.error && (result.error === 'rate-limited' || (typeof result.details === 'string' && result.details.includes('context_length_exceeded')))) {
        // Produce a lightweight mock card to use as a fallback so the clip can be saved
        const mock = mockExplainToCard(page, textInRect, null);
        return { card: mock, error: result.error, details: result.details };
      }
      return result;
}

// Generate multiple-choice questions (MCQs) for a given card-like input.
// Returns { questions: [{ type:'mcq', q, a, choices: [] }, ...], error, details }
export async function remoteGenerateMCQ({ card = {}, aiOverride = null } = {}) {
  const out = { questions: null, error: null, details: null };
  try {
    const settings = await readSettings().catch(() => ({}));
    const ai = aiOverride || settings?.aiApi;
    if (!ai || !ai.enabled || !ai.url) { out.error = 'ai-not-configured'; return out; }

    const controller = new AbortController();
    const timeoutMs = 60000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = ai.token ? { Authorization: 'Bearer ' + ai.token } : {};

      // Build a compact prompt from the card fields to avoid context issues.
      const subject = (card.subject || 'General');
      const topic = (card.topic || '').slice(0, 120);
      const notesShort = (card.notes && (typeof card.notes === 'string' ? card.notes : (card.notes.short || ''))) || '';
      const snippet = (card.snippet && card.snippet.text) ? card.snippet.text : '';
      const promptText = `Create 3 multiple-choice questions (each with 4 choices) based only on the following study card. Return JSON with a top-level array named \"questions\" where each item has keys: \"q\" (question), \"a\" (correct answer), and \"choices\" (array of 4 strings). Do not include any extraneous text.
Subject: ${subject}
Topic: ${topic}
Notes: ${truncateText(notesShort, 800)}
Snippet: ${truncateText(snippet, 600)}\n\nReturn JSON like: { "questions": [ { "q": "...", "a": "...", "choices": ["...","...","...","..."] } ] }`;

      // Use provider-specific shaping similar to remoteExplainToCard
      if (ai.url === 'openai' || (typeof ai.url === 'string' && ai.url.includes('openai.com'))) {
        const model = ai.model || 'gpt-4o-mini';
        const body = { model, input: promptText };
        const openaiUrl = 'https://api.openai.com/v1/responses';
        const resp = await fetchWithRetries(openaiUrl, { method: 'POST', body: JSON.stringify(body), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 6);
        clearTimeout(to);
        if (!resp.ok) {
          out.error = `openai-non-ok:${resp.status}`;
          try { out.details = await resp.text(); } catch(_){}
          return out;
        }
        const json = await resp.json();
        let textOut = '';
        if (json?.output && Array.isArray(json.output)) {
          textOut = json.output.map(o => (o.content || []).map(c => c.text || '').join('')).join('\n');
        } else if (json?.choices && Array.isArray(json.choices)) {
          const c0 = json.choices[0];
          if (c0?.message?.content) {
            if (typeof c0.message.content === 'string') textOut = c0.message.content;
            else if (Array.isArray(c0.message.content)) textOut = c0.message.content.map(c => c.text || '').join('');
          } else if (c0?.text) textOut = c0.text;
        } else if (typeof json === 'string') textOut = json;
        const trimmed = (textOut || '').trim();
        const m = trimmed.match(/\{[\s\S]*\}/);
        const jsonText = m ? m[0] : trimmed;
        try { const parsed = JSON.parse(jsonText); if (parsed && Array.isArray(parsed.questions)) { out.questions = parsed.questions; return out; } } catch (e) { out.error = 'parse-failed'; out.details = (e && e.message) ? e.message : String(e); return out; }
      }

      // Cohere path
      if (ai.url === 'cohere' || (typeof ai.url === 'string' && ai.url.includes('cohere.ai'))) {
        const cohereBody = { model: 'command-xlarge-nightly', prompt: promptText, max_tokens: 400, temperature: 0.2 };
        const cohereUrl = 'https://api.cohere.ai/v1/generate';
        const resp = await fetchWithRetries(cohereUrl, { method: 'POST', body: JSON.stringify(cohereBody), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 3);
        clearTimeout(to);
        if (!resp.ok) { out.error = `cohere-non-ok:${resp.status}`; try { out.details = await resp.text(); } catch(_){}; return out; }
        const json = await resp.json();
        const textOut = (json?.generations && json.generations[0]?.text) || (json?.output && json.output[0]?.content) || json?.text || '';
        const trimmed = (textOut || '').trim();
        const m = trimmed.match(/\{[\s\S]*\}/);
        const jsonText = m ? m[0] : trimmed;
        try { const parsed = JSON.parse(jsonText); if (parsed && Array.isArray(parsed.questions)) { out.questions = parsed.questions; return out; } } catch (e) { out.error = 'parse-failed'; out.details = (e && e.message) ? e.message : String(e); return out; }
      }

      // Generic remote endpoint
      const resp = await fetchWithRetries(ai.url, { method: 'POST', body: JSON.stringify({ card: { subject, topic, notes: truncateText(notesShort, 800), snippet: truncateText(snippet, 600) } }), headers: Object.assign({ 'Content-Type': 'application/json' }, headers), signal: controller.signal }, 6);
      clearTimeout(to);
      if (!resp.ok) { out.error = `remote-non-ok:${resp.status}`; try { out.details = await resp.text(); } catch(_){}; return out; }
      const json = await resp.json();
      const parsed = json?.questions || json;
      if (parsed && Array.isArray(parsed)) { out.questions = parsed; return out; }
      return out;
    } catch (e) {
      try { clearTimeout(to); } catch(_){}
      out.error = (e && e.message) ? e.message : String(e);
      return out;
    } finally { try { clearTimeout(to); } catch(_){} }
  } catch (e) { out.error = (e && e.message) ? e.message : String(e); return out; }
}

function mockExplainToCard(page = {}, text = '', imageBlob = null) {
  // Lightweight heuristic-based mock to produce a useful study card for dev.
  const t = (text || '').trim();
  const title = (page.title || '').trim();

  // Guess a subject from keywords in title or snippet
  const keywords = (title + ' ' + t).toLowerCase();
  let subject = 'General';
  if (/bio|cell|organ|heart|biology/.test(keywords)) subject = 'Biology';
  else if (/chem|molec|atom|reaction|chemistry/.test(keywords)) subject = 'Chemistry';
  else if (/geo|volcano|earth|tectonic|geology/.test(keywords)) subject = 'Geology';
  else if (/math|algebra|geometry|calculus|equation/.test(keywords)) subject = 'Math';

  const topic = title || (t.split(/[\.\n]/)[0] || 'Clip');

  // Notes: split the snippet into up to 3 sentence-like pieces
  const sentences = t ? t.split(/(?<=[\.\?\!])\s+/).filter(Boolean) : [];
  const notesArr = sentences.slice(0, 3).map(s => s.trim());
  if (notesArr.length === 0 && t) notesArr.push(t.slice(0, 240));

  // Build a concise generated-style summary for notes (avoid echoing the exact
  // snippet text). Prefer the first sentence but produce a shortened/paraphrased
  // form so the UI shows a real "summary" instead of an exact copy of the clip.
  const first = sentences[0] || t || '';
  // Short summary: if the first sentence is long, truncate to ~120 chars; else
  // return the sentence but strip excessive whitespace.
  let summary = first.replace(/\s+/g, ' ').trim();
  if (!summary && t) summary = (t || '').replace(/\s+/g, ' ').trim();
  if (summary.length > 120) summary = summary.slice(0, 117).trim() + '...';
  // Prepend a clear label so users know this is the generated summary
  const summaryNote = summary ? summary : 'Summary not available.';

  // Simple QA: one short question (what is X?), one cloze from first noun-like phrase
  const qa = [];
  if (sentences.length) {
    // Create a short-answer QA that asks for the main idea and supplies a
    // concise answer (first ~12 words) rather than echoing the full sentence.
    const firstClean = sentences[0].replace(/\s+/g, ' ').trim();
    const words = firstClean.split(/\s+/).filter(Boolean);
    const shortAnswer = words.slice(0, 12).join(' ');
    qa.push({ type: 'short', q: 'What is the main idea of this clip?', a: shortAnswer });

    // create a cloze question by blanking out a short middle phrase — this will
    // be different from the short-answer above and from the notes summary.
    if (words.length > 6) {
      const mid = Math.floor(words.length / 2);
      const answer = words.slice(mid, Math.min(mid + 2, words.length)).join(' ');
      const clozeQ = firstClean.replace(answer, '_____');
      qa.push({ type: 'cloze', q: clozeQ, a: answer });
    }
  } else if (t) {
    const cleaned = (t || '').replace(/\s+/g, ' ').trim();
    const shortAnswer = cleaned.split(/\s+/).slice(0, 12).join(' ');
    qa.push({ type: 'short', q: 'What is this snippet about?', a: shortAnswer });
  }

  return {
    subject,
    topic: topic.slice(0, 80),
    tags: [],
    // Combine the generated summary with any small extracted notes. The
    // generated summary appears first so the UI shows a distinct, concise
    // paraphrase of the clip rather than echoing source text verbatim.
    notes: ([summaryNote].concat(notesArr)).filter(Boolean).join('\n'),
    // The user requested no questions — return an empty array so the UI will
    // show only the explanatory notes.
    qa: []
  };
}
