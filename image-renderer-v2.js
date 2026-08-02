(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const selector = ".video-cover img, .author-work-card img, .card-avatar, .detail-avatar, .author-avatar";
  const inflight = new Map();
  const assigned = new WeakMap();
  let scanQueued = false;

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function normalizeOrigin(value) {
    try {
      const url = new URL(String(value || "").trim());
      return /^https?:$/.test(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  }

  function domainPayload() {
    try {
      const parsed = JSON.parse(document.querySelector("#domain-json")?.textContent || "{}");
      return parsed?.decoded?.data || parsed?.data || parsed?.decoded || parsed || {};
    } catch {
      return {};
    }
  }

  function resourceOrigins() {
    const payload = domainPayload();
    const values = [
      window.LINE_SELECTOR?.selectedResource?.(),
      localStorage.getItem("hq-manual-resource"),
      document.querySelector("#active-resource")?.textContent,
      ...(Array.isArray(payload.resDomains) ? payload.resDomains : []),
      ...(Array.isArray(payload.resourceDomains) ? payload.resourceDomains : [])
    ];
    return unique(values.map(normalizeOrigin));
  }

  function requestPath(img) {
    const parts = String(img.dataset.imageRequest || "").split("|");
    return String(parts[0] || "").trim();
  }

  function candidateUrls(img, path) {
    const parts = String(img.dataset.imageRequest || "").split("|");
    const explicit = parts.slice(2).filter((value) => /^https?:\/\//i.test(value));
    if (/^https?:\/\//i.test(path)) explicit.unshift(path);
    const relative = String(path || "").replace(/^\/+/, "").replace(/^api\/v1\/(?=web\/img\/)/i, "");
    const generated = resourceOrigins().map((origin) => `${origin}/${relative}`);
    const all = unique([...explicit, ...generated]);
    const expanded = [];
    for (const url of all) {
      if (/\.(?:ceb|geb)(?:$|[?#])/i.test(url)) {
        expanded.push(url.replace(/([?#]|$)/, "@webp-480$1"));
      }
      expanded.push(url);
    }
    return unique(expanded);
  }

  function detectMime(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    return "";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  function wordArrayToBytes(wordArray) {
    const length = wordArray.sigBytes || 0;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
    }
    return bytes;
  }

  async function decodeImage(url) {
    const fetcher = window.__assetRouteFetch || window.__nativeFetch || window.fetch.bind(window);
    const response = await fetcher(url, { cache: "force-cache", credentials: "omit", mode: "cors" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("空响应");

    const rawMime = detectMime(bytes);
    if (rawMime) return URL.createObjectURL(new Blob([bytes], { type: rawMime }));

    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length))).trim();
    if (/^<!doctype html|^<html|<h1[^>]*>\s*404/i.test(prefix)) throw new Error("HTML 404");
    if (/^[{[]/.test(prefix)) {
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (value?.errorCode !== undefined || value?.message) throw new Error(value.message || `errorCode ${value.errorCode}`);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }

    const key = CryptoJS.enc.Utf8.parse(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
    const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });

    let text = "";
    try { text = CryptoJS.enc.Utf8.stringify(decrypted).replace(/\0+$/g, "").trim(); } catch { }
    if (/^data:image\//i.test(text)) return text;
    if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 32) {
      try {
        const binary = atob(text.replace(/\s+/g, ""));
        const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const mime = detectMime(decoded);
        if (mime) return URL.createObjectURL(new Blob([decoded], { type: mime }));
      } catch { }
    }

    const decoded = wordArrayToBytes(decrypted);
    const mime = detectMime(decoded);
    if (!mime) throw new Error("解密结果不是图片");
    return URL.createObjectURL(new Blob([decoded], { type: mime }));
  }

  function cachedImage(img, path) {
    const key = path;
    let promise = inflight.get(key);
    if (!promise) {
      promise = (async () => {
        let lastError = null;
        for (const url of candidateUrls(img, path)) {
          try { return await decodeImage(url); }
          catch (error) { lastError = error; }
        }
        throw lastError || new Error("没有可用图片线路");
      })();
      inflight.set(key, promise);
      promise.catch(() => inflight.delete(key));
    }
    return promise;
  }

  function schedule(img) {
    if (!(img instanceof HTMLImageElement) || !img.matches(selector)) return;
    const path = requestPath(img);
    if (!path) return;
    if (assigned.get(img) === path) return;
    assigned.set(img, path);

    // 只设置一次；不监听 loading/src，避免观察器自触发。
    if (img.loading !== "eager") img.loading = "eager";
    img.decoding = "async";

    cachedImage(img, path).then((src) => {
      if (!img.isConnected || requestPath(img) !== path) return;
      img.onerror = null;
      img.src = src;
      img.dataset.imageState = "loaded";
    }).catch((error) => {
      if (!img.isConnected || requestPath(img) !== path) return;
      assigned.delete(img);
      img.dataset.imageState = "failed";
      img.title = `图片加载失败：${error?.message || String(error)}`;
    });
  }

  function scan(root = document) {
    if (root instanceof HTMLImageElement) schedule(root);
    root.querySelectorAll?.(selector).forEach(schedule);
  }

  function queueScan(root = document) {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan(root);
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) queueScan(node);
      });
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => queueScan(document), { once: true });
  if (document.readyState !== "loading") queueScan(document);
})();
