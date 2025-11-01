// offscreen/offscreen.js
chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    if (msg?.type !== 'CLIPNEST_CROP_IMAGE') return;
    const { requestId, dataUrl, dataUrlKey, imageBlob, rect, dpr } = msg;

    console.log('[offscreen] Received crop request', { requestId, rect, dpr, dataUrlLength: dataUrl?.length, dataUrlKey, hasBlob: !!imageBlob, blobSize: imageBlob?.size });

    // Acknowledge receipt quickly so background knows offscreen is working
    try {
      chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_STARTED', requestId });
      console.log('[offscreen] sent CLIPNEST_CROP_STARTED', requestId);
    } catch (e) {
      console.warn('[offscreen] failed to send CLIPNEST_CROP_STARTED', e);
    }

    // If the sender provided a storage key for the dataUrl, try to read it (avoids large message payloads)
    let effectiveDataUrl = dataUrl;
    if (!effectiveDataUrl && dataUrlKey) {
      try {
        // notify SW we're starting storage read
        try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_STORAGE_READ_START', requestId, dataUrlKey }); } catch(e){}
        // chrome.storage callbacks are more reliable in this context; wrap in a promise with timeout
        effectiveDataUrl = await new Promise((resolve, reject) => {
          let done = false;
          const to = setTimeout(() => {
            if (!done) {
              done = true;
              reject(new Error('storage.get timeout'));
            }
          }, 15000); // allow more time for storage read on slower devices
          try {
            chrome.storage.local.get(dataUrlKey, (resp) => {
              if (done) return;
              done = true;
              clearTimeout(to);
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(resp?.[dataUrlKey]);
            });
          } catch (err) {
            if (!done) { done = true; clearTimeout(to); reject(err); }
          }
        });
        console.log('[offscreen] loaded dataUrl from storage key', dataUrlKey, 'length', effectiveDataUrl?.length);
        try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_STORAGE_READ_DONE', requestId, dataUrlKey, length: effectiveDataUrl?.length }); } catch(e){}
        // Clean up the stored data to avoid accumulating large blobs
        try {
          chrome.storage.local.remove(dataUrlKey, () => { if (chrome.runtime.lastError) console.warn('storage.remove error', chrome.runtime.lastError); });
        } catch (e) { console.warn('storage.remove threw', e); }
      } catch (e) {
        console.warn('[offscreen] failed to read dataUrl from storage key', dataUrlKey, e);
        try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_STORAGE_READ_FAIL', requestId, dataUrlKey, message: String(e?.message || e) }); } catch(e){}
      }
    }

    try {
      const img = new Image();
      let objectUrl = null;
      if (imageBlob) {
        try {
          // Prefer using the Blob directly when possible
          if (typeof imageBlob === 'object' && typeof imageBlob.arrayBuffer === 'function') {
            objectUrl = URL.createObjectURL(imageBlob);
            img.src = objectUrl;
          } else if (imageBlob instanceof Blob) {
            objectUrl = URL.createObjectURL(imageBlob);
            img.src = objectUrl;
          } else {
            throw new TypeError('imageBlob is not a Blob-like object');
          }
        } catch (e) {
          console.warn('[offscreen] createObjectURL failed for imageBlob, attempting fallback', e);
          // Fallback: if effectiveDataUrl is available use it, otherwise if imageBlob has arrayBuffer convert
          if (effectiveDataUrl && typeof effectiveDataUrl === 'string') {
            img.src = effectiveDataUrl;
          } else if (imageBlob && typeof imageBlob.arrayBuffer === 'function') {
            const ab = await imageBlob.arrayBuffer();
            const b = new Blob([ab], { type: imageBlob.type || 'image/png' });
            objectUrl = URL.createObjectURL(b);
            img.src = objectUrl;
          } else {
            throw e;
          }
        }
      } else {
        if (!effectiveDataUrl || typeof effectiveDataUrl !== 'string' || !effectiveDataUrl.startsWith('data:image/')) {
          throw new Error('Invalid image data');
        }
        img.src = effectiveDataUrl;
      }
      await new Promise((resolve, reject) => {
        let timedOut = false;
        const to = setTimeout(() => {
          timedOut = true;
          reject(new Error('Image load timeout'));
        }, 10000); // allow more time for large images
        img.onload = () => { if (!timedOut) { clearTimeout(to); resolve(); } };
        img.onerror = () => { if (!timedOut) { clearTimeout(to); reject(new Error('Failed to load image')); } };
      });
      // decode may still throw for corrupt images
      try { await img.decode(); } catch (e) { console.warn('[offscreen] Image decode warning', e); }

      // revoke object URL once decoded to free memory
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
      }

  console.log('[offscreen] image size', img.width, img.height);
  try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_IMAGE_LOADED', requestId, width: img.width, height: img.height }); } catch(e){}

      // Compute requested region in physical pixels
      let sx = Math.floor((rect.x || 0) * (dpr || 1));
      let sy = Math.floor((rect.y || 0) * (dpr || 1));
      let sw = Math.max(1, Math.floor((rect.w || 0) * (dpr || 1)));
      let sh = Math.max(1, Math.floor((rect.h || 0) * (dpr || 1)));

      // Clamp region to image bounds (avoid failing when coordinates slightly exceed bounds)
      const orig = { sx, sy, sw, sh };
      if (sx < 0) { sw = Math.max(1, sw + sx); sx = 0; }
      if (sy < 0) { sh = Math.max(1, sh + sy); sy = 0; }
      if (sx + sw > img.width) sw = Math.max(1, img.width - sx);
      if (sy + sh > img.height) sh = Math.max(1, img.height - sy);

      console.log('[offscreen] crop coords', { orig, clamped: { sx, sy, sw, sh } });

      if (sw <= 0 || sh <= 0) {
        throw new Error('Crop region has zero area after clamping');
      }

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      console.log('[offscreen] generating cropped blob from canvas');
      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob((b) => {
            if (!b) reject(new Error('Failed to create blob'));
            else resolve(b);
          }, 'image/webp', 0.92);
        } catch (e) { reject(e); }
      });

  console.log('[offscreen] created cropped blob', blob && blob.size);
  try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_BLOB_CREATED', requestId, size: blob?.size }); } catch(e){}

      // Try to send the Blob directly to the service worker to avoid large base64 encoding
      try {
        chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED_BLOB', requestId, blob });
        console.log('[offscreen] sent CLIPNEST_CROPPED_BLOB', requestId);
        // We're done — the SW should convert the blob to a usable form and notify the sidepanel
        return;
      } catch (e) {
        console.warn('[offscreen] sending Blob failed, falling back to dataUrl path', e);
      }

      // Fallback: convert to data URL and send (older environments / message failures)
      const croppedDataUrl = await new Promise((resolve, reject) => {
        try {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('Failed to read blob'));
          r.readAsDataURL(blob);
        } catch (e) { reject(e); }
      });

  console.log('[offscreen] converted blob to dataUrl length', croppedDataUrl?.length);
  try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROP_DATAURL_CREATED', requestId, length: croppedDataUrl?.length }); } catch(e){}

      // Store the cropped dataUrl into chrome.storage.local under a short-lived key
      try {
        const cropKey = `clipnest:crop:${requestId}`;
        const storeObj = { [cropKey]: croppedDataUrl };
        try {
          await new Promise((resolve, reject) => {
            try {
              chrome.storage.local.set(storeObj, () => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve();
              });
            } catch (err) { reject(err); }
          });
          console.log('[offscreen] stored cropped dataUrl to storage key', cropKey);
          try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED_KEY', requestId, cropKey }); } catch(e){}
          // Optionally, schedule cleanup of the key after some time
          setTimeout(() => {
            try { chrome.storage.local.remove(cropKey, () => {}); } catch (e) {}
          }, 5 * 60 * 1000); // remove after 5 minutes
        } catch (e) {
          console.warn('[offscreen] failed to write cropped dataUrl to storage, falling back to runtime message', e);
          try { chrome.runtime.sendMessage({ type: 'CLIPNEST_CROPPED', requestId, croppedDataUrl }); } catch (e2) { console.error('[offscreen] failed to send cropped message', e2); }
        }
      } catch (e) {
        console.error('[offscreen] unexpected error while storing/sending crop', e);
        try { chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId, message: `Crop send failed: ${e.message}` }); } catch (ee) {}
      }
    } catch (err) {
      console.error('Crop failed:', err);
      try {
        chrome.runtime.sendMessage({ type: 'CLIPNEST_ERROR', requestId, message: `Crop failed: ${err.message}` });
      } catch (e) {
        console.error('[offscreen] failed to send error message back to runtime', e);
      }
    }
  })();
});

// Ensure we're ready to handle messages
function notifyReady() {
  try {
    chrome.runtime.sendMessage({ type: 'CLIPNEST_OFFSCREEN_READY' });
    console.log('Offscreen document ready signal sent');
  } catch (e) {
    console.error('Failed to send ready signal:', e);
    // Retry after a short delay
    setTimeout(notifyReady, 100);
  }
}

// Send ready signal both on script load and window load
notifyReady();
window.addEventListener('load', notifyReady);
