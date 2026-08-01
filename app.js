(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const state = {
    activeApi: "",
    activeLatency: null,
    activeResource: "",
    domainData: null,
    catalogData: null,
    videos: [],
    page: Number(config.defaultVideoParams?.page || 1),
    activeVideoId: "",
    currentUrl: "",
    hls: null,
    playlistBlobUrl: "",
    mediaKeyBlobUrl: ""
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    appTitle: $("#app-title"),
    badge: $("#connection-badge"),
    video: $("#video"),
    playerEmpty: $("#player-empty"),
    nowTitle: $("#now-title"),
    nowUrl: $("#now-url"),
    copyUrl: $("#copy-url"),
    manualForm: $("#manual-form"),
    manualUrl: $("#manual-url"),
    restart: $("#restart-button"),
    reloadCatalog: $("#reload-catalog"),
    previousPage: $("#previous-page"),
    nextPage: $("#next-page"),
    pageLabel: $("#page-label"),
    activeApi: $("#active-api"),
    activeLatency: $("#active-latency"),
    activeResource: $("#active-resource"),
    videoCount: $("#video-count"),
    tokenInput: $("#token-input"),
    saveToken: $("#save-token"),
    videoList: $("#video-list"),
    domainJson: $("#domain-json"),
    catalogJson: $("#catalog-json"),
    logOutput: $("#log-output")
  };

  function setBadge(text, kind = "busy") {
    elements.badge.textContent = text;
    elements.badge.className = `badge badge-${kind}`;
  }

  function log(message, details) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let line = `[${time}] ${message}`;
    if (details !== undefined) {
      line += `\n${typeof details === "string" ? details : safeJson(details)}`;
    }
    const old = elements.logOutput.textContent === "页面启动中…" ? "" : elements.logOutput.textContent;
    elements.logOutput.textContent = `${line}\n${old}`.slice(0, 30000);
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function showJson(element, value) {
    element.textContent = safeJson(value);
  }

  function normalizeBase(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text);
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function joinUrl(base, path) {
    return new URL(String(path || "").replace(/^\//, ""), normalizeBase(base)).href;
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function getToken() {
    return elements.tokenInput.value.trim();
  }

  function getApiHeaders(includeJson = false) {
    const headers = {
      t: "2",
      k: "2",
      token: getToken(),
      version: config.webVersion || "1.2.75"
    };
    if (includeJson) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = config.requestTimeoutMs || 10000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        ...options,
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function assertLibraries() {
    const missing = [];
    if (!window.CryptoJS) missing.push("CryptoJS");
    if (!window.pako) missing.push("pako");
    if (!window.Hls) missing.push("hls.js");
    if (missing.length) throw new Error(`外部脚本加载失败：${missing.join("、")}`);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function encryptRequest(data) {
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    return CryptoJS.AES.encrypt(JSON.stringify(data ?? {}), key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    }).toString();
  }

  function decryptResponseData(ciphertext) {
    if (typeof ciphertext !== "string" || !ciphertext) return ciphertext;
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const decrypted = CryptoJS.AES.decrypt(ciphertext, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
    if (!compressedBase64) throw new Error("AES 解密结果为空，密钥或响应格式不匹配");
    const compressedBytes = base64ToBytes(compressedBase64);
    const jsonText = pako.inflate(compressedBytes, { to: "string" });
    return JSON.parse(jsonText);
  }

  function decodeEnvelope(body) {
    if (!body || typeof body !== "object") return body;
    const decoded = Array.isArray(body) ? [...body] : { ...body };
    if (typeof decoded.data === "string" && decoded.data) {
      decoded.data = decryptResponseData(decoded.data);
    }
    return decoded;
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text) return { rawText: "", raw: {}, decoded: {} };
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`服务器没有返回 JSON：${text.slice(0, 180)}`);
    }
    return { rawText: text, raw, decoded: decodeEnvelope(raw) };
  }

  async function apiRequest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const base = options.base || state.activeApi;
    if (!base) throw new Error("API 线路尚未初始化");

    const url = new URL(joinUrl(base, path));
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });

    const requestOptions = {
      method,
      headers: getApiHeaders(method !== "GET")
    };
    if (method !== "GET") {
      requestOptions.body = JSON.stringify({ en: encryptRequest(options.data || {}) });
    }

    log(`${method} ${url.href}`);
    const response = await fetchWithTimeout(url.href, requestOptions, options.timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return parseJsonResponse(response);
  }

  function latencyScore(milliseconds) {
    if (milliseconds <= 100) return 10;
    if (milliseconds <= 250) return 7;
    if (milliseconds <= 500) return 5;
    if (milliseconds <= 700) return 3;
    if (milliseconds <= 1000) return 1;
    return 0;
  }

  function extractServerScore(body) {
    const value = body?.data?.s ?? body?.data?.score ?? body?.s ?? body?.score ?? 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  async function probeApi(base) {
    const started = performance.now();
    const url = joinUrl(base, config.speedtestPath || "speedtest");
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 6500);
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await parseJsonResponse(response);
    const serverScore = extractServerScore(result.decoded);
    const weightedScore = serverScore * 0.75 + latencyScore(elapsed) * 0.25;
    return { base, elapsed, serverScore, weightedScore, response: result.decoded };
  }

  async function selectApi() {
    setBadge("正在测速 API…", "busy");
    const stored = localStorage.getItem(config.storageKeys?.apiCandidates || "");
    const candidates = unique((stored ? stored.split(/\n+/) : config.apiCandidates || []).map(normalizeBase));
    if (!candidates.length) throw new Error("没有配置 API 引导线路");

    log(`开始测速 ${candidates.length} 条 API 线路`, candidates);
    const settled = await Promise.allSettled(candidates.map(probeApi));
    const successful = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        log(`API 线路失败：${candidates[index]}`, result.reason?.message || String(result.reason));
      }
    });
    if (!successful.length) throw new Error("所有 API 线路均不可访问，常见原因是 CORS、证书或服务器离线");

    const preferred = successful
      .filter((item) => item.serverScore >= 5)
      .sort((a, b) => a.elapsed - b.elapsed)[0];
    const winner = preferred || successful.sort((a, b) => b.weightedScore - a.weightedScore || a.elapsed - b.elapsed)[0];

    state.activeApi = winner.base;
    state.activeLatency = winner.elapsed;
    elements.activeApi.textContent = winner.base;
    elements.activeLatency.textContent = `${winner.elapsed} ms`;
    setBadge(`API 已连接 · ${winner.elapsed} ms`, "ok");
    log("API 选线完成", { winner, all: successful });
  }

  function flattenDomainValues(value) {
    if (Array.isArray(value)) return value.flatMap(flattenDomainValues);
    if (typeof value === "string") return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    if (value && typeof value === "object") {
      return Object.values(value).flatMap(flattenDomainValues);
    }
    return [];
  }

  function readDomainField(data, keys) {
    for (const key of keys) {
      if (data?.[key] !== undefined) return flattenDomainValues(data[key]);
    }
    return [];
  }

  async function probeResource(base) {
    const started = performance.now();
    const file = `${String(config.pid || "PH").toLowerCase()}.ceb`;
    const response = await fetchWithTimeout(joinUrl(base, file), { method: "GET" }, config.resourceProbeTimeoutMs || 4500);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { base, elapsed: Math.round(performance.now() - started) };
  }

  async function chooseResource(domains) {
    const normalized = unique(domains.map(normalizeBase));
    if (!normalized.length) return "";
    const settled = await Promise.allSettled(normalized.slice(0, 8).map(probeResource));
    const successful = settled
      .filter((item) => item.status === "fulfilled")
      .map((item) => item.value)
      .sort((a, b) => a.elapsed - b.elapsed);
    if (successful.length) {
      log("资源线路测速完成", successful);
      return successful[0].base;
    }
    log("资源线路无法在浏览器中测速，使用服务器下发的第一条线路");
    return normalized[0];
  }

  async function loadDomainConfig() {
    setBadge("正在获取域名配置…", "busy");
    const result = await apiRequest(config.domainConfigPath || "sys/dmCfg", {
      params: { pid: config.pid || "PH" },
      timeoutMs: 12000
    });
    state.domainData = result.decoded;
    showJson(elements.domainJson, { raw: result.raw, decoded: result.decoded });

    const payload = result.decoded?.data ?? result.decoded;
    const apiDomains = readDomainField(payload, ["apiDomains", "apiUrls"]);
    const resourceDomains = readDomainField(payload, ["resDomains", "resourceDomains", "resourceUrls", "resUrls"]);
    const webDomains = readDomainField(payload, ["webDomains", "webUrls"]);
    const uploadDomains = readDomainField(payload, ["uploadUrl", "uploadUrls", "uploadDomains"]);
    const aiDomains = readDomainField(payload, ["aiDomains", "aiUrls"]);

    state.activeResource = await chooseResource(resourceDomains);
    elements.activeResource.textContent = state.activeResource || "服务器未下发";
    log("域名配置解密成功", {
      apiDomains,
      resourceDomains,
      selectedResource: state.activeResource,
      webDomains,
      uploadDomains,
      aiDomains
    });
  }

  function resolveUrl(value, bases = []) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      return new URL(text).href;
    } catch {
      for (const base of bases) {
        try {
          return joinUrl(base, text);
        } catch {
          // Try the next base.
        }
      }
      return text;
    }
  }

  function appendPlaybackParams(rawUrl) {
    const resolved = resolveUrl(rawUrl, [state.activeApi, state.activeResource]);
    try {
      const url = new URL(resolved);
      url.searchParams.set("pid", config.pid || "PH");
      if (state.activeResource) url.searchParams.set("domain", state.activeResource);
      return url.href;
    } catch {
      const separator = resolved.includes("?") ? "&" : "?";
      return `${resolved}${separator}pid=${encodeURIComponent(config.pid || "PH")}&domain=${encodeURIComponent(state.activeResource || "")}`;
    }
  }

  function normalizeVideoEntry(entry, index) {
    const video = entry?.video || entry?.videoInfo || entry || {};
    const rawPlayUrl = entry?.url || video?.url || video?.playUrl || video?.play_url || video?.videoUrl || video?.video_url || "";
    const title = video?.title || video?.name || video?.videoName || video?.content || video?.description || `视频 ${index + 1}`;
    const cover = video?.coverURL || video?.coverUrl || video?.cover_url || video?.poster || video?.cover || "";
    return {
      id: String(video?.id ?? video?.videoId ?? video?.video_id ?? entry?.id ?? `${state.page}-${index}`),
      title: String(title),
      description: String(video?.description || video?.summary || video?.nickName || video?.username || "服务器视频"),
      duration: String(video?.duration || video?.videoTime || ""),
      poster: resolveUrl(cover, [state.activeResource, state.activeApi]),
      url: appendPlaybackParams(rawPlayUrl),
      protectedPlaylist: true,
      raw: entry
    };
  }

  function findVideoArray(payload, depth = 0) {
    if (depth > 5 || payload == null) return [];
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== "object") return [];
    for (const key of ["videoInfo", "videos", "list", "items", "records", "rows", "data"]) {
      if (payload[key] !== undefined) {
        const found = findVideoArray(payload[key], depth + 1);
        if (found.length) return found;
      }
    }
    return [];
  }

  async function loadVideos() {
    elements.reloadCatalog.disabled = true;
    elements.videoList.innerHTML = '<div class="empty-list">正在请求并解密视频数据…</div>';
    elements.pageLabel.textContent = `第 ${state.page} 页`;
    try {
      const result = await apiRequest(config.videoCatalogPath || "videos/short", {
        params: {
          ...(config.defaultVideoParams || {}),
          pid: config.pid || "PH",
          page: state.page
        }
      });
      state.catalogData = result.decoded;
      showJson(elements.catalogJson, { raw: result.raw, decoded: result.decoded });

      const list = findVideoArray(result.decoded?.data ?? result.decoded);
      state.videos = list.map(normalizeVideoEntry).filter((item) => item.url);
      elements.videoCount.textContent = String(state.videos.length);
      renderVideos();
      log(`视频接口解密完成，第 ${state.page} 页共 ${state.videos.length} 条`, result.decoded);
    } catch (error) {
      state.videos = [];
      elements.videoCount.textContent = "0";
      elements.videoList.innerHTML = `<div class="empty-list">视频数据加载失败：${escapeHtml(error.message)}</div>`;
      showJson(elements.catalogJson, { error: error.message });
      throw error;
    } finally {
      elements.reloadCatalog.disabled = false;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[character]);
  }

  function renderVideos() {
    elements.videoList.replaceChildren();
    if (!state.videos.length) {
      elements.videoList.innerHTML = '<div class="empty-list">服务器返回成功，但没有识别到可播放视频。</div>';
      return;
    }

    state.videos.forEach((video, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `video-card${video.id === state.activeVideoId ? " active" : ""}`;

      const cover = document.createElement("div");
      cover.className = "video-cover";
      if (video.poster) {
        const image = document.createElement("img");
        image.loading = "lazy";
        image.alt = "";
        image.src = video.poster;
        image.addEventListener("error", () => image.remove());
        cover.append(image);
      }
      const badge = document.createElement("span");
      badge.textContent = video.duration || `#${index + 1}`;
      cover.append(badge);

      const meta = document.createElement("div");
      meta.className = "video-meta";
      const title = document.createElement("strong");
      title.textContent = video.title;
      const description = document.createElement("small");
      description.textContent = video.description;
      meta.append(title, description);
      button.append(cover, meta);
      button.addEventListener("click", () => playVideo(video));
      elements.videoList.append(button);
    });
  }

  function destroyPlayerObjects() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    if (state.playlistBlobUrl) {
      URL.revokeObjectURL(state.playlistBlobUrl);
      state.playlistBlobUrl = "";
    }
  }

  function getMediaKeyBlobUrl() {
    if (!state.mediaKeyBlobUrl) {
      const bytes = base64ToBytes(config.mediaKeyBase64);
      state.mediaKeyBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    }
    return state.mediaKeyBlobUrl;
  }

  function rewritePlaylist(playlist, sourceUrl) {
    const keyUrl = getMediaKeyBlobUrl();
    return playlist
      .split(/\r?\n/)
      .map((line) => {
        if (!line) return line;
        if (line.startsWith("#EXT-X-KEY")) {
          return line.replace(/URI="[^"]*"/i, `URI="${keyUrl}"`);
        }
        if (line.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
            try {
              return `URI="${new URL(uri, sourceUrl).href}"`;
            } catch {
              return match;
            }
          });
        }
        try {
          return new URL(line.trim(), sourceUrl).href;
        } catch {
          return line;
        }
      })
      .join("\n");
  }

  async function fetchProtectedPlaylist(url) {
    const response = await fetchWithTimeout(url, {
      headers: { m: "1" }
    }, 15000);
    if (!response.ok) throw new Error(`播放列表请求失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    let playlist = "";
    try {
      playlist = pako.inflate(bytes, { to: "string" });
      log("m3u8 zlib 解压成功", { compressedBytes: bytes.byteLength, textLength: playlist.length });
    } catch {
      playlist = new TextDecoder("utf-8").decode(bytes);
      log("播放列表不是 zlib 数据，按普通文本处理");
    }
    if (!playlist.includes("#EXTM3U")) throw new Error("服务器返回内容不是 HLS 播放列表");
    return rewritePlaylist(playlist, url);
  }

  async function attachHls(source) {
    if (elements.video.canPlayType("application/vnd.apple.mpegurl")) {
      elements.video.src = source;
      await elements.video.play().catch(() => undefined);
      return;
    }
    if (!Hls.isSupported()) throw new Error("当前浏览器不支持 HLS/MSE");

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60
    });
    state.hls = hls;
    hls.attachMedia(elements.video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source));
    hls.on(Hls.Events.MANIFEST_PARSED, () => elements.video.play().catch(() => undefined));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      log("HLS 播放事件", data);
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else hls.destroy();
    });
  }

  async function playVideo(video) {
    destroyPlayerObjects();
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();
    state.activeVideoId = video.id;
    state.currentUrl = video.url;
    elements.nowTitle.textContent = video.title;
    elements.nowUrl.textContent = video.url;
    elements.copyUrl.disabled = false;
    elements.playerEmpty.hidden = true;
    renderVideos();
    setBadge("正在加载视频…", "busy");

    try {
      let source = video.url;
      if (video.protectedPlaylist) {
        try {
          const playlist = await fetchProtectedPlaylist(video.url);
          state.playlistBlobUrl = URL.createObjectURL(new Blob([playlist], { type: "application/vnd.apple.mpegurl" }));
          source = state.playlistBlobUrl;
        } catch (error) {
          log("受保护 m3u8 处理失败，尝试直接播放原地址", error.message);
        }
      }

      if (/\.m3u8(?:$|[?#])/i.test(source) || source.startsWith("blob:")) {
        await attachHls(source);
      } else {
        elements.video.src = source;
        await elements.video.play().catch(() => undefined);
      }
      setBadge("视频已加载", "ok");
    } catch (error) {
      setBadge("视频播放失败", "error");
      log("视频播放失败", error.message);
    }
  }

  async function initialize() {
    try {
      assertLibraries();
      setBadge("正在自动连接…", "busy");
      elements.restart.disabled = true;
      await selectApi();
      await loadDomainConfig();
      await loadVideos();
      setBadge(`已连接 · ${state.activeLatency} ms`, "ok");
    } catch (error) {
      setBadge("初始化失败", "error");
      log("初始化失败", error.message);
      if (!state.domainData) showJson(elements.domainJson, { error: error.message });
    } finally {
      elements.restart.disabled = false;
    }
  }

  function bindEvents() {
    elements.restart.addEventListener("click", initialize);
    elements.reloadCatalog.addEventListener("click", () => loadVideos().catch((error) => log("刷新失败", error.message)));
    elements.previousPage.addEventListener("click", () => {
      if (state.page <= 1) return;
      state.page -= 1;
      loadVideos().catch((error) => log("上一页加载失败", error.message));
    });
    elements.nextPage.addEventListener("click", () => {
      state.page += 1;
      loadVideos().catch((error) => log("下一页加载失败", error.message));
    });
    elements.saveToken.addEventListener("click", () => {
      localStorage.setItem(config.storageKeys?.token || "hq-video-token", getToken());
      initialize();
    });
    elements.manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = elements.manualUrl.value.trim();
      if (!url) return;
      playVideo({ id: "manual", title: "手动播放地址", url, protectedPlaylist: false });
    });
    elements.copyUrl.addEventListener("click", () => navigator.clipboard.writeText(state.currentUrl));
    document.querySelectorAll(".copy-json").forEach((button) => {
      button.addEventListener("click", () => {
        const target = document.getElementById(button.dataset.target);
        navigator.clipboard.writeText(target?.textContent || "");
      });
    });
    window.addEventListener("beforeunload", () => {
      destroyPlayerObjects();
      if (state.mediaKeyBlobUrl) URL.revokeObjectURL(state.mediaKeyBlobUrl);
    });
  }

  function boot() {
    elements.appTitle.textContent = config.appName || document.title;
    const queryToken = new URLSearchParams(location.search).get("token");
    const storedToken = localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "";
    elements.tokenInput.value = queryToken || storedToken;
    if (queryToken) localStorage.setItem(config.storageKeys?.token || "hq-video-token", queryToken);
    bindEvents();
    if (config.autoStart !== false) initialize();
  }

  boot();
})();
