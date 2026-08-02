(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const cache = new Map();
  const tasks = new WeakMap();
  const imageSelector = ".card-avatar, .detail-avatar, .author-avatar, .video-cover img, .author-work-card img";

  function isManagedImage(img) {
    return img instanceof HTMLImageElement && img.matches(imageSelector);
  }

  function isCover(img) {
    return img instanceof HTMLImageElement && Boolean(img.closest(".video-cover, .author-work-card"));
  }

  function isPlaceholder(src) {
    return !src || /^data:image\/svg\+xml/i.test(String(src));
  }

  function forceVisible(img) {
    img.removeAttribute("loading");
    img.loading = "eager";
    img.decoding = "async";
    img.style.setProperty("display", "block", "important");
    img.style.setProperty("visibility", "visible", "important");
    img.style.setProperty("opacity", "1", "important");
    if (isCover(img)) {
      img.style.setProperty("width", "100%", "important");
      img.style.setProperty("height", "100%", "important");
      img.style.setProperty("object-fit", "cover", "important");
    }
  }

  function requestPath(img) {
    return String(img.dataset.imageRequest || "").split("|")[0].trim();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function resourceBases() {
    const values = [];
    const manual = window.LINE_SELECTOR?.selectedResource?.() || localStorage.getItem("hq-manual-resource") || "";
    if (manual) values.push(manual);

    const active = document.querySelector("#active-resource")?.textContent?.trim();
    if (active && active !== "—" && !active.includes("未下发")) values.push(active);

    try {
      const text = document.querySelector("#domain-json")?.textContent || "";
      const parsed = JSON.parse(text);
      const payload = parsed?.decoded?.data || parsed?.data || parsed?.decoded || parsed;
      const domains = payload?.resDomains || payload?.resourceDomains || payload?.resourceUrls || [];
      (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    } catch {
      // 域名配置尚未就绪。
    }

    return unique(values.map((value) => {
      try {
        const url = new URL(value);
        return url.href.endsWith("/") ? url.href : `${url.href}/`;
      } catch {
        return "";
      }
    }));
  }

  function imageCandidates(img, path) {
    const fromRequest = String(img.dataset.imageRequest || "")
      .split("|")
      .slice(2)
      .filter((value) => /^https?:\/\//i.test(value));

    const generated = [];
    if (/^https?:\/\//i.test(path)) {
      generated.push(path);
    } else {
      for (const base of resourceBases()) {
        try {
          generated.push(new URL(path.replace(/^\/+/, ""), base).href);
        } catch {
          // 继续尝试其他资源线路。
        }
      }
    }

    const expanded = [];
    const preferredSize = isCover(img) ? 480 : 160;
    for (const url of [...fromRequest, ...generated]) {
      if (/\.(?:ceb|geb)(?:$|[?#])/i.test(url) && !/@(?:webp|png)-\d+/i.test(url)) {
        expanded.push(`${url}@webp-${preferredSize}`);
        if (preferredSize !== 480) expanded.push(`${url}@webp-480`);
      }
      expanded.push(url);
    }
    return unique(expanded);
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
    const length = wordArray.sigBytes || 0;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
    }
    return bytes;
  }

  function decryptedSource(wordArray) {
    let text = "";
    try {
      text = CryptoJS.enc.Utf8.stringify(wordArray).replace(/\0+$/g, "").trim();
    } catch {
      text = "";
    }

    if (/^data:image\//i.test(text)) return text;
    if (text && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try {
        const clean = text.replace(/\s+/g, "");
        const bytes = base64ToBytes(clean);
        const mime = detectMime(bytes);
        if (mime) return `data:${mime};base64,${clean}`;
      } catch {
        // 继续按二进制图片处理。
      }
    }

    const bytes = wordArrayToBytes(wordArray);
    const mime = detectMime(bytes);
    if (!mime) throw new Error("图片解密结果不是图片");
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  async function decodeCandidate(url) {
    const fetcher = window.__assetRouteFetch || window.__nativeFetch || window.fetch.bind(window);
    const response = await fetcher(url, {
      cache: "force-cache",
      credentials: "omit",
      mode: "cors"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const rawMime = detectMime(bytes);
    if (rawMime) return URL.createObjectURL(new Blob([bytes], { type: rawMime }));

    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 256))).trim().toLowerCase();
    if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.includes("<h1>404</h1>")) {
      throw new Error("资源节点返回 HTML 404");
    }
    if (prefix.startsWith("{")) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (payload?.errorCode !== undefined || payload?.message) {
          throw new Error(payload.message || `errorCode ${payload.errorCode}`);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // 加密二进制偶然以 { 开头，继续尝试解密。
        } else {
          throw error;
        }
      }
    }

    const key = CryptoJS.enc.Utf8.parse(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
    const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    return decryptedSource(decrypted);
  }

  function preload(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(src);
      probe.onerror = () => reject(new Error("浏览器无法显示图片"));
      probe.src = src;
    });
  }

  async function loadImage(img, path) {
    const key = `${isCover(img) ? "cover" : "avatar"}|${path}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = (async () => {
        const errors = [];
        for (const candidate of imageCandidates(img, path)) {
          try {
            return await preload(await decodeCandidate(candidate));
          } catch (error) {
            errors.push(`${candidate}：${error?.message || String(error)}`);
          }
        }
        throw new Error(errors[0] || "没有可用图片地址");
      })();
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
    }
    return promise;
  }

  function schedule(img) {
    if (!isManagedImage(img)) return;
    forceVisible(img);

    const current = img.currentSrc || img.src || "";
    if (!isPlaceholder(current) && img.complete && img.naturalWidth > 0) {
      img.dataset.imageState = "loaded";
      if (isCover(img)) img.dataset.coverHotfix = "loaded";
      return;
    }

    const path = requestPath(img);
    if (!path) return;
    const taskKey = `${isCover(img) ? "cover" : "avatar"}|${path}`;
    if (tasks.get(img) === taskKey) return;

    tasks.set(img, taskKey);
    loadImage(img, path)
      .then((src) => {
        if (requestPath(img) !== path) return;
        img.onerror = null;
        img.referrerPolicy = "no-referrer";
        forceVisible(img);
        img.src = src;
        img.dataset.imageState = "loaded";
        img.dataset.imageHotfix = "loaded";
        if (isCover(img)) img.dataset.coverHotfix = "loaded";
      })
      .catch((error) => {
        if (requestPath(img) === path) {
          img.dataset.imageHotfix = "failed";
          if (isCover(img)) img.dataset.coverHotfix = "failed";
          img.title = `图片加载失败：${error?.message || String(error)}`;
        }
      })
      .finally(() => {
        if (tasks.get(img) === taskKey) tasks.delete(img);
      });
  }

  function scan(root = document) {
    if (isManagedImage(root)) schedule(root);
    root.querySelectorAll?.(imageSelector).forEach(schedule);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") schedule(mutation.target);
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) scan(node);
      });
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "data-image-request", "data-image-state", "loading"]
  });

  document.addEventListener("error", (event) => schedule(event.target), true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan(), { once: true });
  else scan();
})();