(() => {
  "use strict";

  const baseFetch = window.__nativeFetch || window.fetch.bind(window);
  const pending = new Map();

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

  function resourceOrigins() {
    const values = [];
    const manual = window.LINE_SELECTOR?.selectedResource?.() || localStorage.getItem("hq-manual-resource") || "";
    if (manual) values.push(manual);

    const active = document.querySelector("#active-resource")?.textContent?.trim();
    if (active && active !== "—" && !active.includes("未下发")) values.push(active);

    try {
      const parsed = JSON.parse(document.querySelector("#domain-json")?.textContent || "{}");
      const payload = parsed?.decoded?.data || parsed?.data || parsed?.decoded || parsed || {};
      const domains = payload.resDomains || payload.resourceDomains || payload.resourceUrls || [];
      (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    } catch {
      // 域名配置尚未完成。
    }

    return unique(values.map(normalizeOrigin));
  }

  function inputUrl(input) {
    try {
      return new URL(typeof input === "string" ? input : input.url, location.href);
    } catch {
      return null;
    }
  }

  function isEncryptedImage(url) {
    return Boolean(url && /\.(?:ceb|geb)(?:@[^/?#]+)?(?:$|[?#])/i.test(url.href));
  }

  function canonicalImagePath(url) {
    let pathname = String(url.pathname || "/").replace(/\/{2,}/g, "/");
    pathname = pathname.replace(/^\/api\/v1(?=\/web\/img\/)/i, "");
    return `${pathname}${url.search || ""}`;
  }

  function candidatesFor(url) {
    const path = canonicalImagePath(url);
    const apiImage = /^\/api\/v1\/web\/img\//i.test(String(url.pathname || "").replace(/\/{2,}/g, "/"));
    const candidates = [];

    for (const origin of resourceOrigins()) {
      candidates.push(`${origin}${path.startsWith("/") ? path : `/${path}`}`);
    }

    if (!apiImage) candidates.unshift(url.href);
    return unique(candidates);
  }

  function hasImageMagic(bytes) {
    if (bytes.length < 4) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
    return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }

  async function validImageResponse(response) {
    if (!response.ok) return false;
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (!bytes.length) return false;
    if (hasImageMagic(bytes)) return true;

    const type = String(response.headers.get("content-type") || "").toLowerCase();
    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trim().toLowerCase();
    if (type.includes("text/html") || prefix.startsWith("<!doctype html") || prefix.startsWith("<html")) return false;
    if (type.includes("application/json") || prefix.startsWith("{")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed?.errorCode !== undefined || parsed?.message) return false;
      } catch {
        // 加密二进制可能偶然以“{”开头，不据此拒绝。
      }
    }

    return bytes.length > 1024;
  }

  async function routedFetch(input, init = {}) {
    const url = inputUrl(input);
    const method = String(init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    if (method !== "GET" || !isEncryptedImage(url)) return baseFetch(input, init);

    const key = canonicalImagePath(url);
    let request = pending.get(key);
    if (!request) {
      request = (async () => {
        let lastResponse = null;
        let lastError = null;
        for (const candidate of candidatesFor(url)) {
          try {
            const response = await baseFetch(candidate, init);
            lastResponse = response;
            if (await validImageResponse(response)) return response;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastResponse) return lastResponse;
        throw lastError || new Error("没有可用的图片资源线路");
      })().finally(() => pending.delete(key));
      pending.set(key, request);
    }

    const response = await request;
    return response.clone();
  }

  window.__nativeFetch = routedFetch;
  window.__assetRouteFetch = routedFetch;
})();
