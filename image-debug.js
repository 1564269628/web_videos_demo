(() => {
  "use strict";

  const VERSION = "20260802-16";
  const config = window.VIDEO_APP_CONFIG || {};
  const report = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    events: [],
    probes: [],
    summary: {}
  };
  window.IMAGE_DEBUG_REPORT = report;

  const observedState = new WeakMap();
  const rescueStarted = new WeakSet();
  const loggedRequests = new Set();
  const objectUrls = new Set();
  let logCount = 0;
  const MAX_LOG_LINES = 140;

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function maskUrl(value) {
    const text = String(value || "");
    try {
      const url = new URL(text, location.href);
      for (const key of ["token", "s", "sign", "authorization"]) {
        if (url.searchParams.has(key)) url.searchParams.set(key, "***");
      }
      return url.href;
    } catch {
      return text;
    }
  }

  function appendLog(message, details, level = "info") {
    const event = {
      time: new Date().toISOString(),
      level,
      message,
      details
    };
    report.events.unshift(event);
    report.events.splice(300);

    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[consoleMethod](`[IMAGE DEBUG ${VERSION}] ${message}`, details ?? "");

    if (logCount >= MAX_LOG_LINES) return;
    logCount += 1;
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const block = `[${time}] [图片诊断] ${message}${details === undefined ? "" : `\n${safeJson(details)}`}\n`;
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `${block}${old}`.slice(0, 80000);
  }

  function imageKind(img) {
    if (img.matches(".video-cover img")) return "视频封面";
    if (img.matches(".card-avatar")) return "卡片头像";
    if (img.matches(".detail-avatar")) return "播放详情头像";
    if (img.matches(".author-avatar")) return "作者主页头像";
    if (img.closest(".author-work-card")) return "作者作品封面";
    return "普通图片";
  }

  function isPlaceholder(src) {
    return /^data:image\/svg\+xml/i.test(String(src || ""));
  }

  function parseRequest(img) {
    const parts = String(img.dataset.imageRequest || "").split("|");
    return {
      path: parts[0] || "",
      size: Number(parts[1] || 0),
      candidates: parts.slice(2).filter(Boolean).map(maskUrl)
    };
  }

  function hex(bytes, limit = 24) {
    return [...bytes.subarray(0, Math.min(limit, bytes.length))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(" ");
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

  function decodeEncryptedBytes(bytes) {
    if (!window.CryptoJS) throw new Error("CryptoJS 未加载");
    const keyText = String(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
    const key = CryptoJS.enc.Utf8.parse(keyText);
    const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });

    let text = "";
    try { text = CryptoJS.enc.Utf8.stringify(decrypted).replace(/\0+$/g, "").trim(); }
    catch { text = ""; }

    if (/^data:image\//i.test(text)) {
      const comma = text.indexOf(",");
      const decoded = comma >= 0 ? base64ToBytes(text.slice(comma + 1)) : new Uint8Array();
      return { src: text, bytes: decoded, mime: text.slice(5, text.indexOf(";")) || "data-image", mode: "data-url" };
    }

    if (text.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try {
        const decoded = base64ToBytes(text);
        const mime = detectMime(decoded);
        if (mime) return { bytes: decoded, mime, mode: "base64-text" };
      } catch {
        // 继续按二进制解密结果处理。
      }
    }

    const decoded = wordArrayToBytes(decrypted);
    return { bytes: decoded, mime: detectMime(decoded), mode: "binary" };
  }

  function blobUrl(bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    objectUrls.add(url);
    return url;
  }

  function preload(src, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => reject(new Error("图片预加载超时")), timeoutMs);
      image.onload = () => {
        clearTimeout(timer);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error("浏览器无法解码该图片"));
      };
      image.src = src;
    });
  }

  async function probeCandidate(candidate) {
    const started = performance.now();
    const fetcher = window.__assetRouteFetch || window.__nativeFetch || window.fetch.bind(window);
    const result = {
      candidate: maskUrl(candidate),
      startedAt: new Date().toISOString()
    };

    try {
      const response = await fetcher(candidate, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        mode: "cors"
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const rawMime = detectMime(bytes);
      Object.assign(result, {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Math.round(performance.now() - started),
        contentType: response.headers.get("content-type") || "",
        contentLengthHeader: response.headers.get("content-length") || "",
        cors: response.headers.get("access-control-allow-origin") || "",
        byteLength: bytes.length,
        rawMime,
        rawHeadHex: hex(bytes)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!bytes.length) throw new Error("响应体为空");

      let src = "";
      if (rawMime) {
        result.decodeMode = "raw-image";
        result.finalMime = rawMime;
        src = blobUrl(bytes, rawMime);
      } else {
        result.decodeMode = "aes-ecb-pkcs7";
        const decoded = decodeEncryptedBytes(bytes);
        result.decryptMode = decoded.mode;
        result.decryptedByteLength = decoded.bytes?.length || 0;
        result.decryptedMime = decoded.mime || "";
        result.decryptedHeadHex = hex(decoded.bytes || new Uint8Array());
        if (!decoded.mime && !decoded.src) throw new Error("AES 解密后没有识别到图片文件头");
        src = decoded.src || blobUrl(decoded.bytes, decoded.mime);
        result.finalMime = decoded.mime || "data-image";
      }

      const dimensions = await preload(src);
      result.preload = "success";
      result.width = dimensions.width;
      result.height = dimensions.height;
      result.success = true;
      result.src = src;
      report.probes.unshift({ ...result, src: src.startsWith("blob:") ? "blob:…" : src.slice(0, 80) });
      return result;
    } catch (error) {
      result.success = false;
      result.error = `${error?.name || "Error"}: ${error?.message || String(error)}`;
      result.elapsedMs = result.elapsedMs ?? Math.round(performance.now() - started);
      report.probes.unshift(result);
      throw Object.assign(new Error(result.error), { diagnostic: result });
    }
  }

  async function rescue(img) {
    if (rescueStarted.has(img)) return;
    rescueStarted.add(img);
    const request = parseRequest(img);
    if (!request.candidates.length) {
      appendLog(`${imageKind(img)}没有候选 URL`, request, "error");
      return;
    }

    appendLog(`${imageKind(img)}开始独立探测`, {
      path: request.path,
      size: request.size,
      candidates: request.candidates
    }, "warn");

    const failures = [];
    for (const candidate of request.candidates) {
      try {
        const result = await probeCandidate(candidate);
        if (!img.isConnected || img.dataset.imageRequest !== [request.path, request.size, ...request.candidates].join("|")) {
          appendLog(`${imageKind(img)}探测成功但节点已经变化`, {
            path: request.path,
            candidate: result.candidate,
            dimensions: `${result.width}x${result.height}`
          }, "warn");
          return;
        }
        img.onerror = null;
        img.src = result.src;
        img.dataset.imageState = "loaded";
        img.dataset.imageDebugRescued = "1";
        img.removeAttribute("data-image-error");
        appendLog(`${imageKind(img)}诊断恢复成功`, {
          path: request.path,
          candidate: result.candidate,
          http: result.status,
          byteLength: result.byteLength,
          rawMime: result.rawMime || "未识别",
          decodeMode: result.decodeMode,
          decryptedMime: result.decryptedMime || "",
          dimensions: `${result.width}x${result.height}`
        });
        return;
      } catch (error) {
        failures.push(error.diagnostic || { candidate, error: error.message });
      }
    }

    appendLog(`${imageKind(img)}全部候选线路均失败`, {
      path: request.path,
      originalError: img.dataset.imageError || "",
      failures
    }, "error");
  }

  function inspectImage(img, reason = "scan") {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.matches(".video-cover img, .card-avatar, .detail-avatar, .author-avatar, .author-work-card img")) return;

    const request = parseRequest(img);
    const snapshot = [
      img.dataset.imageRequest || "",
      img.dataset.imageState || "",
      img.dataset.imageError || "",
      img.currentSrc || img.src || ""
    ].join("\n");
    if (observedState.get(img) === snapshot) return;
    observedState.set(img, snapshot);

    if (request.path && !loggedRequests.has(`${imageKind(img)}:${request.path}`)) {
      loggedRequests.add(`${imageKind(img)}:${request.path}`);
      appendLog(`${imageKind(img)}进入加载队列`, {
        reason,
        path: request.path,
        requestedSize: request.size,
        candidateCount: request.candidates.length,
        candidates: request.candidates,
        currentResource: document.querySelector("#active-resource")?.textContent?.trim() || "",
        currentApi: document.querySelector("#active-api")?.textContent?.trim() || ""
      });
    }

    const state = img.dataset.imageState || "unset";
    if (state === "loaded") {
      queueMicrotask(() => {
        appendLog(`${imageKind(img)}标记为 loaded`, {
          path: request.path,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          srcType: String(img.currentSrc || img.src).split(":", 1)[0],
          placeholder: isPlaceholder(img.currentSrc || img.src),
          rescued: img.dataset.imageDebugRescued === "1"
        }, img.naturalWidth > 0 ? "info" : "warn");
      });
    } else if (state === "failed") {
      appendLog(`${imageKind(img)}主加载器失败`, {
        path: request.path,
        error: img.dataset.imageError || img.title || "未知错误",
        candidates: request.candidates,
        src: String(img.currentSrc || img.src).slice(0, 160),
        complete: img.complete,
        naturalWidth: img.naturalWidth
      }, "error");
      rescue(img);
    }
  }

  function scan(root = document, reason = "scan") {
    if (root instanceof HTMLImageElement) inspectImage(root, reason);
    root.querySelectorAll?.(".video-cover img, .card-avatar, .detail-avatar, .author-avatar, .author-work-card img")
      .forEach((img) => inspectImage(img, reason));
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        inspectImage(mutation.target, `attribute:${mutation.attributeName}`);
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
    attributeFilter: ["src", "data-image-request", "data-image-state", "data-image-error"]
  });

  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement) {
      const img = event.target;
      appendLog(`${imageKind(img)}触发原生 error 事件`, {
        request: parseRequest(img),
        src: String(img.currentSrc || img.src).slice(0, 200),
        state: img.dataset.imageState || "",
        error: img.dataset.imageError || ""
      }, "error");
      if (img.dataset.imageState === "failed") rescue(img);
    }
  }, true);

  function summarize() {
    const images = [...document.querySelectorAll(".video-cover img, .card-avatar, .detail-avatar, .author-avatar, .author-work-card img")];
    const states = {};
    for (const img of images) {
      const state = img.dataset.imageState || "unset";
      states[state] = (states[state] || 0) + 1;
    }
    report.summary = {
      at: new Date().toISOString(),
      total: images.length,
      states,
      decodedVisible: images.filter((img) => img.naturalWidth > 0 && !isPlaceholder(img.currentSrc || img.src)).length,
      placeholders: images.filter((img) => isPlaceholder(img.currentSrc || img.src)).length,
      currentResource: document.querySelector("#active-resource")?.textContent?.trim() || "",
      resourceOptions: [...document.querySelectorAll("#resource-line-select option")].map((option) => option.value).filter(Boolean),
      imageAesKeyLength: String(config.imageAesKey || "").length,
      cryptoJsReady: Boolean(window.CryptoJS),
      nativeFetchReady: typeof window.__nativeFetch === "function",
      assetRouteFetchReady: typeof window.__assetRouteFetch === "function"
    };
    appendLog("图片状态汇总", report.summary);
  }

  appendLog("图片诊断器已启动", {
    version: VERSION,
    imageAesKeyLength: String(config.imageAesKey || "").length,
    cryptoJsReady: Boolean(window.CryptoJS),
    nativeFetchReady: typeof window.__nativeFetch === "function",
    assetRouteFetchReady: typeof window.__assetRouteFetch === "function"
  });

  scan(document, "startup");
  setTimeout(() => scan(document, "delayed-scan"), 1500);
  setTimeout(summarize, 5000);
  setTimeout(summarize, 12000);

  window.addEventListener("beforeunload", () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });
})();
