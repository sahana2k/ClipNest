// content/overlay.js
(() => {
  if (window.__clipnestOverlayLoaded) return;
  window.__clipnestOverlayLoaded = true;

  const overlay = document.createElement('div');
  overlay.id = 'clipnest-overlay';
  overlay.innerHTML = `<div class="cn-help">Drag to clip • ESC to cancel</div><div id="cn-rect"></div>`;
  document.documentElement.appendChild(overlay);

  let startX, startY, rect, dragging = false;

  const px = (n) => `${n}px`;

  function begin() {
    overlay.style.display = 'block';
    overlay.tabIndex = -1;
    overlay.focus();
  }

  function end() {
    overlay.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
  }

  function onDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    rect = document.getElementById('cn-rect');
    rect.style.left = px(startX);
    rect.style.top = px(startY);
    rect.style.width = '0px';
    rect.style.height = '0px';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    rect.style.left = px(x);
    rect.style.top = px(y);
    rect.style.width = px(w);
    rect.style.height = px(h);
  }

  function getTextInRect(bounds) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const r = el.getBoundingClientRect();
        const intersects = !(r.right < bounds.left || r.left > bounds.right ||
                             r.bottom < bounds.top || r.top > bounds.bottom);
        return intersects ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const parts = [];
    while (tw.nextNode()) parts.push(tw.currentNode.nodeValue.trim());
    return parts.join(' ').replace(/\s+/g, ' ').slice(0, 1200);
  }

  async function onUp(e) {
    if (!dragging) return;
    dragging = false;

    const rectEl = document.getElementById('cn-rect');
    const b = rectEl.getBoundingClientRect();
    end();
    if (b.width < 5 || b.height < 5) return;

    const bounds = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    const textInRect = getTextInRect(bounds);

    const requestId = crypto.randomUUID();
    try {
      console.info('[clipnest][content] sending CLIPNEST_SELECTION', requestId, { rect: { x: b.left, y: b.top, w: b.width, h: b.height } });
      chrome.runtime.sendMessage({
        type: 'CLIPNEST_SELECTION',
        requestId,
        rect: { x: b.left, y: b.top, w: b.width, h: b.height },
        dpr: window.devicePixelRatio || 1,
        url: location.href,
        title: document.title,
        textInRect
      });
    } catch (e) {
      console.error('[clipnest][content] failed to send CLIPNEST_SELECTION', e);
    }
  }

  overlay.addEventListener('mousedown', onDown, true);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(); }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'CLIPNEST_START') begin();
    if (msg?.type === 'CLIPNEST_CONTENT_CROP') {
      (async () => {
        try {
          const { requestId, dataUrlKey, dataUrl, rect, dpr } = msg;
          let src = dataUrl;
          if (!src && dataUrlKey) {
            try { src = (await new Promise((res, rej) => { chrome.storage.local.get(dataUrlKey, (r) => { if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message)); res(r?.[dataUrlKey]); }); })); } catch (e) { src = null; }
          }
          if (!src) {
            chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId, message: 'No capture available to crop' });
            return;
          }

          // scale rect by dpr if provided
          const s = dpr || window.devicePixelRatio || 1;
          const sx = Math.round((rect.x || 0) * s);
          const sy = Math.round((rect.y || 0) * s);
          const sw = Math.max(1, Math.round((rect.w || 1) * s));
          const sh = Math.max(1, Math.round((rect.h || 1) * s));

          // Fetch blob and createImageBitmap for efficient decoding
          let blob = null;
          try {
            const resp = await fetch(src);
            blob = await resp.blob();
          } catch (e) { blob = null; }

          let bitmap = null;
          if (blob && self.createImageBitmap) {
            try { bitmap = await createImageBitmap(blob); } catch (e) { bitmap = null; }
          }

          // If createImageBitmap failed, fall back to Image element draw
          const canvas = document.createElement('canvas');
          canvas.width = sw; canvas.height = sh;
          const ctx = canvas.getContext('2d');

          if (bitmap) {
            ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
          } else {
            // draw via Image element
            await new Promise((res, rej) => {
              const img = new Image();
              img.onload = () => {
                try { ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh); res(); } catch (err) { rej(err); }
              };
              img.onerror = (e) => rej(new Error('Image load failed'));
              img.src = src;
            });
          }

          // produce blob
          const croppedBlob = await new Promise((res, rej) => { canvas.toBlob((b) => { if (!b) return rej(new Error('toBlob failed')); res(b); }, 'image/png'); });

          // Try to send blob directly, but also create & store a dataURL fallback
          // so the background/service worker can read the cropped image even if
          // structured-clone Blob transfer fails silently. We send the fallback
          // key (CLIPNEST_CROPPED_KEY) immediately after storing so the SW can
          // proceed without waiting for a blob message.
          const keyFallback = `clipnest:crop:${requestId}`;
          try {
            // Create dataURL (synchronous) and store under a short-lived key
            const dataUrlFallback = canvas.toDataURL('image/png');
            try {
              chrome.storage.local.set({ [keyFallback]: dataUrlFallback }, () => {
                  if (chrome.runtime.lastError) {
                    console.info('[clipnest][content] Could not write crop fallback key', chrome.runtime.lastError);
                  } else {
                    console.info('[clipnest][content] wrote crop fallback key', keyFallback);
                  }
                // Notify background that a crop key is available (reliable)
                try {
                    console.info('[clipnest][content] sending CLIPNEST_CROPPED_KEY', requestId, keyFallback);
                  chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED_KEY', requestId, cropKey: keyFallback });
                } catch (e) {
                    console.warn('[clipnest][content] Failed to send CLIPNEST_CROPPED_KEY', e);
                }
                // Also attempt to send the Blob; this may succeed and is preferred
                try {
                    console.info('[clipnest][content] attempting CLIPNEST_CROPPED_BLOB send', requestId);
                  chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED_BLOB', requestId, blob: croppedBlob });
                } catch (e) {
                  console.warn('[clipnest][content] Failed to send CLIPNEST_CROPPED_BLOB (blob transfer may be unsupported)', e);
                }
              });
            } catch (e) {
              console.debug('[clipnest][content] storage.set threw when writing crop fallback key', e);
            }
            return;
          } catch (e) {
            /* fallback below */
          }

          // Fallback: convert to dataURL and store under key
          const dataUrlCropped = canvas.toDataURL('image/png');
          const cropKey = `clipnest:crop:${requestId}`;
          try { await new Promise((res, rej) => { chrome.storage.local.set({ [cropKey]: dataUrlCropped }, () => { if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message)); res(); }); });
            chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED_KEY', requestId, cropKey });
            return;
          } catch (e) {
            // last fallback: send data in message (may be large)
            chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED', requestId, croppedDataUrl: dataUrlCropped });
            return;
          }
        } catch (err) {
          try { chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId: msg?.requestId, message: err?.message || 'Content crop failed' }); } catch (e) {}
        }
      })();
    }
  });
})();
