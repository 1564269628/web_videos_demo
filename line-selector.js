(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const rawFetch = window.fetch.bind(window);
  const KEYS = {
    api: "hq-manual-api",
    playApi: "hq-manual-play-api",
    resource: "hq-manual-resource"
  };
  const originalApiCandidates = Array.isArray(config.apiCandidates) ? [...config.apiCandidates] : [];

  function normalizeBase(value, keepPath = true) {
    try {
      const url = new URL(String(value || "").trim());
      if (!/^https?:$/.test(url.protocol)) return "";
      if (!keepPath) return `${url.protocol}//${url.host}/`;
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function stored(key) {
    return localStorage.getItem(key) || "";
  }

  const selectedAtBoot = {
    api: normalizeBase(stored(KEYS.api)),
    playApi: normalizeBase(stored(KEYS.playApi)),
    resource: normalizeBase(stored(KEYS.resource), false)
  };

  if (selectedAtBoot.api) {
    config.apiCandidates = [selectedAtBoot.api];
    config.useDynamicApiDomains = false;
  }

  function rewriteRequest(input) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input.url, location.href);
    } catch {
      return input;
    }

    const playApi = normalizeBase(stored(KEYS.playApi));
    const resource = normalizeBase(stored(KEYS.resource), false);
    const isPlaylistApi = /\/videos\/m3u8\//i.test(url.pathname);
    const isSegment = /\.(?:ts|m4s|aac)(?:$|[?#])/i.test(url.href);

    if (isPlaylistApi && playApi) {
      const target = new URL(playApi);
      url.protocol = target.protocol;
      url.host = target.host;
      if (url.searchParams.has("h")) url.searchParams.set("h", target.host);
    }
    if (isPlaylistApi && resource) {
      url.searchParams.set("domain", resource);
    }
    if (isSegment && resource) {
      const target = new URL(resource);
      url.protocol = target.protocol;
      url.host = target.host;
      url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    }

    if (typeof input === "string") return url.href;
    return new Request(url.href, input);
  }

  window.fetch = (input, init) => rawFetch(rewriteRequest(input), init);
  window.__lineSelectorRawFetch = rawFetch;

  const state = {
    apiCandidates: [...originalApiCandidates],
    resourceCandidates: [],
    apiLatency: new Map(),
    resourceLatency: new Map(),
    probing: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);

  function injectStyles() {
    if ($("#line-selector-styles")) return;
    const style = document.createElement("style");
    style.id = "line-selector-styles";
    style.textContent = `
      .line-selector-panel { display:grid; gap:14px; }
      .line-selector-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
      .line-selector-group { display:grid; gap:7px; }
      .line-selector-group label { font-size:13px; color:var(--muted,#aab4ce); }
      .line-selector-group select { width:100%; min-width:0; padding:9px 10px; border-radius:9px; border:1px solid rgba(125,140,255,.28); background:rgba(8,13,26,.86); color:inherit; }
      .line-latencies { display:grid; gap:5px; max-height:170px; overflow:auto; padding-right:3px; }
      .line-latency-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .line-latency-url { overflow-wrap:anywhere; color:var(--muted,#aab4ce); }
      .line-latency-value { white-space:nowrap; }
      .line-ok { color:#67d8bc; } .line-bad { color:#ff8d9b; } .line-wait { color:#d9c477; }
      .line-selector-note { margin:0; font-size:12px; line-height:1.5; color:var(--muted,#aab4ce); }
    `;
    document.head.append(style);
  }

  function ensurePanel() {
    injectStyles();
    let panel = $("#line-selector-panel");
    if (panel) return panel;
    panel = document.createElement("section");
    panel.id = "line-selector-panel";
    panel.className = "panel line-selector-panel";
    panel.innerHTML = `
      <div class="line-selector-head">
        <div><p class="label">手动选线</p><h2>API 与播放线路</h2></div>
        <button type="button" class="ghost-button" id="probe-all-lines">重新测速</button>
      </div>
      <div class="line-selector-group">
        <label for="manual-api-select">业务 API（切换后刷新页面）</label>
        <select id="manual-api-select"></select>
        <div class="line-latencies" id="api-latencies"></div>
      </div>
      <div class="line-selector-group">
        <label for="manual-play-api-select">M3U8 播放 API（可与业务 API 不同）</label>
        <select id="manual-play-api-select"></select>
      </div>
      <div class="line-selector-group">
        <label for="manual-resource-select">视频/图片资源 CDN</label>
        <select id="manual-resource-select"></select>
        <div class="line-latencies" id="resource-latencies"></div>
      </div>
      <p class="line-selector-note">“自动”表示继续使用程序测速结果。资源线路切换后会重新加载当前视频；业务 API 切换会刷新页面。</p>`;
    const status = $(".status-panel");
    status?.insertAdjacentElement("afterend", panel);

    $("#probe-all-lines", panel).addEventListener("click", probeAll);
    $("#manual-api-select", panel).addEventListener("change", (event) => {
      const value = normalizeBase(event.target.value);
      if (value) localStorage.setItem(KEYS.api, value);
      else localStorage.removeItem(KEYS.api);
      location.reload();
    });
    $("#manual-play-api-select", panel).addEventListener("change", (event) => {
      const value = normalizeBase(event.target.value);
      if (value) localStorage.setItem(KEYS.playApi, value);
      else localStorage.removeItem(KEYS.playApi);
      replayCurrent();
    });
    $("#manual-resource-select", panel).addEventListener("change", (event) => {
      const value = normalizeBase(event.target.value, false);
      if (value) localStorage.setItem(KEYS.resource, value);
      else localStorage.removeItem(KEYS.resource);
      enforceResourceDisplay();
      replayCurrent();
    });
    return panel;
  }

  function optionText(url, map) {
    const result = map.get(url);
    if (!result) return url;
    return result.ok ? `${result.elapsed} ms · ${url}` : `失败 · ${url}`;
  }

  function renderSelect(selector, candidates, selected, latencyMap, autoLabel) {
    const select = $(selector);
    if (!select) return;
    const isResource = selector.includes("resource");
    const values = unique(candidates.map((value) => normalizeBase(value, !isResource)));
    select.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = autoLabel;
    select.append(auto);
    values.forEach((url) => {
      const option = document.createElement("option");
      option.value = url;
      option.textContent = optionText(url, latencyMap);
      select.append(option);
    });
    if (selected && !values.includes(selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = optionText(selected, latencyMap);
      select.append(option);
    }
    select.value = selected || "";
  }

  function renderLatencyList(selector, candidates, map) {
    const root = $(selector);
    if (!root) return;
    root.replaceChildren();
    const isResource = selector.includes("resource");
    unique(candidates).forEach((value) => {
      const url = normalizeBase(value, !isResource);
      if (!url) return;
      const result = map.get(url);
      const row = document.createElement("div");
      row.className = "line-latency-row";
      const name = document.createElement("span");
      name.className = "line-latency-url";
      name.textContent = url;
      const latency = document.createElement("span");
      latency.className = `line-latency-value ${!result ? "line-wait" : result.ok ? "line-ok" : "line-bad"}`;
      latency.textContent = !result ? "等待测速" : result.ok ? `${result.elapsed} ms` : "不可用";
      latency.title = result?.error || "";
      row.append(name, latency);
      root.append(row);
    });
  }

  function render() {
    ensurePanel();
    const apiSelected = normalizeBase(stored(KEYS.api));
    const playSelected = normalizeBase(stored(KEYS.playApi));
    const resourceSelected = normalizeBase(stored(KEYS.resource), false);
    renderSelect("#manual-api-select", state.apiCandidates, apiSelected, state.apiLatency, "自动选择业务 API");
    renderSelect("#manual-play-api-select", state.apiCandidates, playSelected, state.apiLatency, "跟随接口返回的播放地址");
    renderSelect("#manual-resource-select", state.resourceCandidates, resourceSelected, state.resourceLatency, "自动选择资源线路");
    renderLatencyList("#api-latencies", state.apiCandidates, state.apiLatency);
    renderLatencyList("#resource-latencies", state.resourceCandidates, state.resourceLatency);
  }

  function parseDomainConfig() {
    try {
      const parsed = JSON.parse($("#domain-json")?.textContent || "");
      const payload = parsed?.decoded?.data || parsed?.data || parsed?.decoded || parsed;
      const apis = Array.isArray(payload?.apiDomains) ? payload.apiDomains : [];
      const resources = Array.isArray(payload?.resDomains) ? payload.resDomains : [];
      if (apis.length) state.apiCandidates = unique([...originalApiCandidates, ...apis]);
      if (resources.length) state.resourceCandidates = unique(resources);
    } catch {
      // 配置尚未返回。
    }
  }

  async function probeOne(url, type) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), type === "api" ? 6500 : 4500);
    const started = performance.now();
    try {
      const target = type === "api"
        ? new URL(config.speedtestPath || "speedtest", normalizeBase(url)).href
        : new URL(`${String(config.pid || "PH").toLowerCase()}.ceb?line_probe=${Date.now()}`, normalizeBase(url, false)).href;
      const response = await rawFetch(target, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: type === "api" ? { Accept: "application/json" } : undefined
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, elapsed: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, elapsed: null, error: error?.message || String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function probeAll() {
    if (state.probing) return;
    state.probing = true;
    parseDomainConfig();
    render();
    try {
      await Promise.all(state.apiCandidates.map(async (value) => {
        const url = normalizeBase(value);
        const result = await probeOne(url, "api");
        state.apiLatency.set(url, result);
        render();
      }));
      await Promise.all(state.resourceCandidates.map(async (value) => {
        const url = normalizeBase(value, false);
        const result = await probeOne(url, "resource");
        state.resourceLatency.set(url, result);
        render();
      }));
    } finally {
      state.probing = false;
      render();
    }
  }

  function enforceResourceDisplay() {
    const selected = normalizeBase(stored(KEYS.resource), false);
    const element = $("#active-resource");
    if (selected && element && element.textContent !== selected) element.textContent = selected;
  }

  function replayCurrent() {
    enforceResourceDisplay();
    const url = $("#now-url")?.textContent?.trim();
    if (!url || url === "—") return;
    const input = $("#manual-url");
    if (input) input.value = url;
    setTimeout(() => $("#manual-form")?.requestSubmit(), 50);
  }

  function boot() {
    ensurePanel();
    render();
    enforceResourceDisplay();

    const domain = $("#domain-json");
    if (domain) {
      const observer = new MutationObserver(() => {
        parseDomainConfig();
        render();
        enforceResourceDisplay();
        if (!state.probing) probeAll();
      });
      observer.observe(domain, { childList: true, subtree: true, characterData: true });
    }

    const resourceDisplay = $("#active-resource");
    if (resourceDisplay) {
      new MutationObserver(enforceResourceDisplay).observe(resourceDisplay, { childList: true, subtree: true, characterData: true });
    }

    setTimeout(probeAll, 800);
  }

  window.LINE_SELECTOR = {
    keys: KEYS,
    selectedApi: () => normalizeBase(stored(KEYS.api)),
    selectedPlayApi: () => normalizeBase(stored(KEYS.playApi)),
    selectedResource: () => normalizeBase(stored(KEYS.resource), false),
    rawFetch
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
