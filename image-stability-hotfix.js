(() => {
  "use strict";

  const VERSION = "20260802-17";
  const TARGETS = ".video-cover img, .card-avatar, .detail-avatar, .author-avatar, .author-work-card img";
  const stableCache = new Map();
  const pending = new Map();
  const retryTimers = new WeakMap();
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  let stabilized = 0;
  let restored = 0;
  let failures = 0;

  window.IMAGE_STABILITY = {
    version: VERSION,
    stableCache,
    pending,
    get summary() {
      return { stabilized, restored, failures, cached: stableCache.size, pending: pending.size };
    }
  };

  function log(message, details, level = "log") {
    console[level](`[IMAGE STABILITY ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const line = `[${time}] [图片稳定器] ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`;
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `${line}${old}`.slice(0, 80000);
  }

  function isPlaceholder(src) {
    return /^data:image\/svg\+xml/i.test(String(src || ""));
  }

  function requestInfo(img) {
    const raw = String(img.dataset.imageRequest || "");
    const parts = raw.split("|");
    return {
      key: raw,
      path: parts[0] || "",
      size: Number(parts[1] || 0),
      candidates: parts.slice(2).filter(Boolean)
    };
  }

  function detectMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
    if (bytes.length >= 12) {
      const brand = String.fromCharCode(...bytes.subarray(4, 12));
      if (brand.includes("ftypavif") || brand.includes("ftypavis")) return "image/avif";
    }
    return "";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function wordArrayToBytes(wordArray) {
    const length = wordArray?.sigBytes || 0;
    const words = wordArray?.words || [];
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
    }
    return bytes;
  }

  function dataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  function decodeCeb(bytes) {
    const config = window.VIDEO_APP_CONFIG || {};
    const key = CryptoJS.enc.Utf8.parse(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
    const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });

    let text = "";
    try {
      text = CryptoJS.enc.Utf8.stringify(decrypted).replace(/\0+$/g, "").trim();
    } catch {
      text = "";
    }

    if (/^data:image\//i.test(text)) return text;
    if (text.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try {
        const decoded = base64ToBytes(text);
        const mime = detectMime(decoded);
        if (mime) return dataUrl(decoded, mime);
      } catch {
        // Fall through to binary output.
      }
    }

    const decoded = wordArrayToBytes(decrypted);
    const mime = detectMime(decoded);
    if (!mime) throw new Error("AES 解密后没有识别到图片格式");
    return dataUrl(decoded, mime);
  }

  function preload(src, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      const timer = setTimeout(() => reject(new Error("图片预加载超时")), timeoutMs);
      probe.onload = () => {
        clearTimeout(timer);
        if (!probe.naturalWidth) reject(new Error("图片宽度为 0"));
        else resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
      };
      probe.onerror = () => {
        clearTimeout(timer);
        reject(new Error("浏览器无法解码图片"));
      };
      probe.src = src;
    });
  }

  async function blobToStable(src) {
    const response = await nativeFetch(src);
    if (!response.ok) throw new Error(`Blob HTTP ${response.status}`);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = blob.type.startsWith("image/") ? blob.type.split(";")[0] : detectMime(bytes);
    if (!mime) throw new Error("Blob 中没有识别到图片格式");
    return dataUrl(bytes, mime);
  }

  async function candidateToStable(candidate) {
    const response = await nativeFetch(candidate, {
      method: "GET",
      cache: "force-cache",
      credentials: "omit",
      mode: "cors"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("响应为空");
    const mime = detectMime(bytes);
    return mime ? dataUrl(bytes, mime) : decodeCeb(bytes);
  }

  async function buildStableSource(img, info) {
    const current = String(img.currentSrc || img.src || "");
    if (/^data:image\//i.test(current) && !isPlaceholder(current)) return current;

    if (/^blob:/i.test(current)) {
      try {
        return await blobToStable(current);
      } catch {
        // Blob 地址不可复用时，重新从资源线路获取。
      }
    }

    const errors = [];
    for (const candidate of info.candidates) {
      try {
        const src = await candidateToStable(candidate);
        await preload(src);
        return src;
      } catch (error) {
        errors.push(`${candidate}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | ") || "没有可用图片候选地址");
  }

  async function stableSource(img, info) {
    const cached = stableCache.get(info.key);
    if (typeof cached === "string") return cached;
    if (cached) return cached;

    let task = pending.get(info.key);
    if (!task) {
      task = buildStableSource(img, info)
        .then(async (src) => {
          await preload(src);
          stableCache.set(info.key, src);
          stabilized += 1;
          return src;
        })
        .finally(() => pending.delete(info.key));
      pending.set(info.key, task);
      stableCache.set(info.key, task);
    }
    return task;
  }

  async function applyStable(img, reason = "scan") {
    if (!(img instanceof HTMLImageElement) || !img.matches(TARGETS)) return;
    const info = requestInfo(img);
    if (!info.key || !info.path) return;

    const cached = stableCache.get(info.key);
    if (typeof cached === "string") {
      const current = String(img.currentSrc || img.src || "");
      if (current !== cached || img.naturalWidth === 0) {
        img.onerror = null;
        img.src = cached;
        img.dataset.imageState = "loaded";
        img.dataset.imageStable = "1";
        restored += 1;
      }
      return;
    }

    if (img.dataset.imageStable === "1" && img.naturalWidth > 0) return;

    const current = String(img.currentSrc || img.src || "");
    const shouldStabilize =
      /^blob:/i.test(current) ||
      (/^data:image\//i.test(current) && !isPlaceholder(current)) ||
      img.dataset.imageState === "failed" ||
      (img.dataset.imageState === "loaded" && img.complete && img.naturalWidth === 0);

    if (!shouldStabilize) {
      clearTimeout(retryTimers.get(img));
      const timer = setTimeout(() => applyStable(img, "delayed-check"), 350);
      retryTimers.set(img, timer);
      return;
    }

    try {
      const src = await stableSource(img, info);
      if (!img.isConnected || img.dataset.imageRequest !== info.key) return;
      img.onerror = null;
      img.src = src;
      img.dataset.imageState = "loaded";
      img.dataset.imageStable = "1";
      img.removeAttribute("data-image-error");
      restored += 1;
      if (reason !== "scan") log("已恢复重建后的图片", { path: info.path, reason });
    } catch (error) {
      failures += 1;
      img.dataset.imageStableError = String(error.message || error).slice(0, 1000);
      console.warn(`[IMAGE STABILITY ${VERSION}] 稳定化失败`, info.path, error);
    }
  }

  function scan(root = document, reason = "scan") {
    if (root instanceof HTMLImageElement) applyStable(root, reason);
    root.querySelectorAll?.(TARGETS).forEach((img) => applyStable(img, reason));
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        applyStable(mutation.target, `attribute:${mutation.attributeName}`);
      } else {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node, "node-added");
        });
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "data-image-request", "data-image-state"]
  });

  document.addEventListener("click", () => {
    setTimeout(() => scan(document, "after-click-100ms"), 100);
    setTimeout(() => scan(document, "after-click-500ms"), 500);
  }, true);

  let rounds = 0;
  const warmup = setInterval(() => {
    scan(document, "warmup");
    rounds += 1;
    if (rounds >= 30) clearInterval(warmup);
  }, 500);

  scan(document, "boot");
  log("稳定缓存已启用", { version: VERSION });
})();
