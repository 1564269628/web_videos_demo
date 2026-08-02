(() => {
  "use strict";

  const previousFetch = window.__nativeFetch || window.fetch.bind(window);

  function toUrl(input) {
    try {
      return new URL(typeof input === "string" ? input : input.url, location.href);
    } catch {
      return null;
    }
  }

  function isMediaSegment(url) {
    return Boolean(url && /\.(?:ts|m4s|aac)(?:$|[?#])/i.test(url.href));
  }

  function normalizePath(pathname) {
    return String(pathname || "/").replace(/\/{2,}/g, "/");
  }

  function resourceBases() {
    const values = [];
    const active = document.querySelector("#active-resource")?.textContent?.trim();
    if (active && active !== "—" && !active.includes("未下发")) values.push(active);

    try {
      const text = document.querySelector("#domain-json")?.textContent || "";
      const parsed = JSON.parse(text);
      const payload = parsed?.decoded?.data || parsed?.data || parsed?.decoded || parsed;
      const domains = payload?.resDomains || payload?.resourceDomains || payload?.resourceUrls || [];
      (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    } catch {
      // 域名配置尚未显示时，只使用当前地址。
    }

    const result = [];
    for (const value of values) {
      try {
        const url = new URL(value);
        const base = `${url.protocol}//${url.host}`;
        if (!result.includes(base)) result.push(base);
      } catch {
        // 忽略无效资源地址。
      }
    }
    return result;
  }

  function candidatesFor(original) {
    const result = [];
    const add = (value) => {
      const href = value.href;
      if (!result.some((item) => item.href === href)) result.push(value);
    };

    add(original);

    const normalized = new URL(original.href);
    normalized.pathname = normalizePath(normalized.pathname);
    add(normalized);

    for (const base of resourceBases()) {
      try {
        const candidate = new URL(base);
        candidate.pathname = normalizePath(original.pathname);
        candidate.search = original.search;
        add(candidate);
      } catch {
        // 继续尝试其他资源线路。
      }
    }
    return result;
  }

  async function invalidSegmentResponse(response) {
    if (!response.ok) return `HTTP ${response.status}`;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (!bytes.length) return "空响应";

    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trim().toLowerCase();
    if (
      type.includes("text/html") ||
      type.includes("application/json") ||
      prefix.startsWith("<!doctype html") ||
      prefix.startsWith("<html") ||
      /<h1[^>]*>\s*404\s*<\/h1>/.test(prefix)
    ) {
      return "服务器返回 HTML 404 页面";
    }
    return "";
  }

  window.__nativeFetch = async (input, init = {}) => {
    const original = toUrl(input);
    const method = String(init.method || "GET").toUpperCase();
    if (!isMediaSegment(original) || method !== "GET") return previousFetch(input, init);

    const errors = [];
    for (const candidate of candidatesFor(original)) {
      try {
        const response = await previousFetch(candidate.href, init);
        const invalid = await invalidSegmentResponse(response);
        if (!invalid) return response;
        errors.push(`${candidate.href}：${invalid}`);
      } catch (error) {
        errors.push(`${candidate.href}：${error?.message || String(error)}`);
      }
    }

    const detail = errors[0] || original.href;
    throw new Error(`视频分片不可用；已修正双斜杠并尝试备用资源线路。${detail}`);
  };
})();
