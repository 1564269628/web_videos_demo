(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const state = {
    activeApi: "",
    activeLatency: null,
    resourceBases: [],
    videos: [],
    activeVideoId: null,
    currentUrl: "",
    mediaCandidates: [],
    mediaCandidateIndex: 0,
    hls: null
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    appTitle: $("#app-title"),
    badge: $("#connection-badge"),
    video: $("#video"),
    playerEmpty: $("#player-empty"),
    nowTitle: $("#now-title"),
    copyUrl: $("#copy-url"),
    manualForm: $("#manual-form"),
    manualUrl: $("#manual-url"),
    candidates: $("#api-candidates"),
    probeButton: $("#probe-button"),
    reloadCatalog: $("#reload-catalog"),
    activeApi: $("#active-api"),
    resourceCount: $("#resource-count"),
    activeLatency: $("#active-latency"),
    videoList: $("#video-list"),
    logOutput: $("#log-output")
  };

  function setBadge(text, kind = "idle") {
    elements.badge.textContent = text;
    elements.badge.className = `badge badge-${kind}`;
  }

  function log(message, details) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let line = `[${time}] ${message}`;
    if (details !== undefined) {
      try {
        line += `\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`;
      } catch {
        line += `\n${String(details)}`;
      }
    }
    const previous = elements.logOutput.textContent === "等待操作…" ? "" : elements.logOutput.textContent;
    elements.logOutput.textContent = `${line}\n${previous}`.slice(0, 16000);
  }

  function normalizeBase(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    try {
      const url = new URL(trimmed);
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function joinUrl(base, path) {
    return new URL(String(path || "").replace(/^\//, ""), normalizeBase(base)).href;
  }

  function getCandidateLines() {
    return unique(
      elements.candidates.value
        .split(/[\n,]+/)
        .map(normalizeBase)
    );
  }

  function latencyScore(ms) {
    if (ms <= 100) return 10;
    if (ms <= 250) return 7;
    if (ms <= 500) return 5;
    if (ms <= 700) return 3;
    if (ms <= 1000) return 1;
    return 0;
  }

  function normalizeServerScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    if (numeric > 10 && numeric <= 100) return Math.min(10, numeric / 10);
    return Math.max(0, Math.min(10, numeric));
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      Number(config.requestTimeoutMs) || 4500
    );

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

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("服务器没有返回普通 JSON；可能存在加密响应或返回了网页内容");
    }
  }

  function unwrapPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    if (typeof payload.en === "string") {
      throw new Error("检测到加密字段 en。本项目不包含第三方私有解密密钥");
    }
    if (payload.data !== undefined) return payload.data;
    return payload;
  }

  async function probeCandidate(base) {
    const speedUrl = joinUrl(base, config.speedtestPath || "speedtest");
    const started = performance.now();
    const response = await fetchWithTimeout(speedUrl, {
      headers: { Accept: "application/json" }
    });
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let serverScore = 0;
    try {
      const payload = await readJson(response);
      const unwrapped = unwrapPayload(payload);
      serverScore = normalizeServerScore(
        unwrapped?.s ?? unwrapped?.score ?? payload?.s ?? payload?.score ?? 0
      );
    } catch (error) {
      // 部分测速接口只返回空内容。网络延迟仍然可以用于选择线路。
      log(`${base} 测速响应无法解析，按延迟计分`, error.message);
    }

    const networkScore = latencyScore(elapsed);
    const serverWeight = Number(config.scoreWeights?.server ?? 0.75);
    const latencyWeight = Number(config.scoreWeights?.latency ?? 0.25);
    const score = serverScore * serverWeight + networkScore * latencyWeight;

    return { base, elapsed, serverScore, networkScore, score };
  }

  function extractDomainArray(payload, keys) {
    for (const key of keys) {
      const value = payload?.[key];
      if (Array.isArray(value)) return value.map(normalizeBase).filter(Boolean);
      if (typeof value === "string") {
        return value.split(/[\n,]+/).map(normalizeBase).filter(Boolean);
      }
    }
    return [];
  }

  async function loadDomainConfig() {
    if (!state.activeApi || !config.domainConfigPath) return;

    const url = new URL(joinUrl(state.activeApi, config.domainConfigPath));
    if (config.pid) url.searchParams.set("pid", config.pid);

    const response = await fetchWithTimeout(url.href, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`域名配置请求失败：HTTP ${response.status}`);

    const body = await readJson(response);
    const payload = unwrapPayload(body);
    const resourceBases = extractDomainArray(payload, [
      "resDomains",
      "resourceDomains",
      "resourceUrls",
      "resUrls"
    ]);
    const apiDomains = extractDomainArray(payload, ["apiDomains", "apiUrls"]);

    state.resourceBases = unique(resourceBases);
    elements.resourceCount.textContent = String(state.resourceBases.length);

    if (apiDomains.length) {
      log("服务器下发了额外 API 线路", apiDomains);
    }
    if (state.resourceBases.length) {
      log("资源线路已更新", state.resourceBases);
    } else {
      log("域名配置中没有识别到资源线路，将使用媒体原始地址");
    }
  }

  async function selectBestApi() {
    const candidates = getCandidateLines();
    if (!candidates.length) {
      setBadge("请先填写 API", "error");
      log("没有可测速的 API 地址");
      return;
    }

    localStorage.setItem(config.storageKeys?.candidates || "video-player-api-candidates", candidates.join("\n"));
    setBadge("正在测速…", "busy");
    elements.probeButton.disabled = true;
    log(`开始并发测速 ${candidates.length} 条线路`);

    try {
      const settled = await Promise.allSettled(candidates.map(probeCandidate));
      const successful = settled
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value)
        .sort((a, b) => b.score - a.score || a.elapsed - b.elapsed);

      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          log(`线路失败：${candidates[index]}`, result.reason?.message || String(result.reason));
        }
      });

      if (!successful.length) throw new Error("所有 API 线路都不可访问。请检查地址、HTTPS 和 CORS 设置");

      const winner = successful[0];
      state.activeApi = winner.base;
      state.activeLatency = winner.elapsed;
      elements.activeApi.textContent = winner.base;
      elements.activeLatency.textContent = `${winner.elapsed} ms`;
      setBadge(`已连接 · ${winner.elapsed} ms`, "ok");
      log("已选择综合评分最高的线路", successful);

      try {
        await loadDomainConfig();
      } catch (error) {
        state.resourceBases = [];
        elements.resourceCount.textContent = "0";
        log("域名配置获取失败，仍可使用本地目录和手动地址", error.message);
      }

      await loadCatalog();
    } catch (error) {
      state.activeApi = "";
      state.activeLatency = null;
      elements.activeApi.textContent = "—";
      elements.activeLatency.textContent = "—";
      setBadge("线路不可用", "error");
      log("测速选线失败", error.message);
    } finally {
      elements.probeButton.disabled = false;
    }
  }

  function findArray(value, depth = 0) {
    if (depth > 4 || value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];

    for (const key of ["list", "items", "records", "rows", "videos", "data"]) {
      if (value[key] !== undefined) {
        const result = findArray(value[key], depth + 1);
        if (result.length) return result;
      }
    }
    return [];
  }

  function normalizeVideo(item, index) {
    if (typeof item === "string") {
      return { id: `video-${index}`, title: `视频 ${index + 1}`, url: item, poster: "", description: "" };
    }

    const url = item?.url || item?.playUrl || item?.play_url || item?.videoUrl || item?.video_url || item?.src || "";
    return {
      id: String(item?.id ?? item?.videoId ?? item?.video_id ?? `video-${index}`),
      title: String(item?.title || item?.name || item?.videoName || `视频 ${index + 1}`),
      url: String(url),
      poster: String(item?.poster || item?.cover || item?.coverUrl || item?.cover_url || item?.thumb || ""),
      description: String(item?.description || item?.summary || item?.duration || "")
    };
  }

  async function fetchCatalog(url) {
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`视频目录请求失败：HTTP ${response.status}`);
    const body = await readJson(response);
    const payload = unwrapPayload(body);
    return findArray(payload).map(normalizeVideo).filter((video) => video.url);
  }

  async function loadCatalog() {
    elements.reloadCatalog.disabled = true;
    elements.videoList.innerHTML = '<div class="empty-list">正在加载视频目录…</div>';

    try {
      let videos = [];
      if (state.activeApi && config.remoteCatalogPath) {
        try {
          videos = await fetchCatalog(joinUrl(state.activeApi, config.remoteCatalogPath));
          log(`已从远程 API 加载 ${videos.length} 个视频`);
        } catch (error) {
          log("远程视频目录不可用，回退到本地示例", error.message);
        }
      }

      if (!videos.length) {
        videos = await fetchCatalog(config.catalogPath || "./data/videos.json");
        log(`已加载本地目录，共 ${videos.length} 个视频`);
      }

      state.videos = videos;
      renderVideoList();
    } catch (error) {
      state.videos = [];
      renderVideoList();
      log("视频目录加载失败", error.message);
    } finally {
      elements.reloadCatalog.disabled = false;
    }
  }

  function resolveAgainstBases(rawUrl, bases) {
    const value = String(rawUrl || "").trim();
    if (!value) return [];

    try {
      return [new URL(value).href];
    } catch {
      return unique(
        bases.map((base) => {
          try {
            return joinUrl(base, value);
          } catch {
            return "";
          }
        })
      );
    }
  }

  function buildMediaCandidates(video) {
    const bases = unique([...state.resourceBases, state.activeApi]);
    return resolveAgainstBases(video.url, bases);
  }

  function resolvePoster(url) {
    const candidates = resolveAgainstBases(url, unique([...state.resourceBases, state.activeApi]));
    return candidates[0] || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='100%25' height='100%25' fill='%23101524'/%3E%3Cpath d='M132 52l72 38-72 38z' fill='%237c8cff'/%3E%3C/svg%3E";
  }

  function renderVideoList() {
    elements.videoList.replaceChildren();
    if (!state.videos.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "暂无视频。可使用上方手动播放地址。";
      elements.videoList.append(empty);
      return;
    }

    state.videos.forEach((video) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `video-card${state.activeVideoId === video.id ? " active" : ""}`;

      const image = document.createElement("img");
      image.loading = "lazy";
      image.alt = "";
      image.src = resolvePoster(video.poster);

      const text = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = video.title;
      const description = document.createElement("span");
      description.textContent = video.description || (video.url.toLowerCase().includes("m3u8") ? "HLS 视频" : "视频文件");
      text.append(title, description);
      button.append(image, text);
      button.addEventListener("click", () => playVideo(video));
      elements.videoList.append(button);
    });
  }

  function destroyHls() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
  }

  function isHlsUrl(url) {
    return /\.m3u8(?:$|[?#])/i.test(url);
  }

  async function attachSource(url) {
    destroyHls();
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();

    if (isHlsUrl(url)) {
      if (window.Hls?.isSupported()) {
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 60,
          maxBufferLength: 30
        });
        state.hls = hls;
        hls.loadSource(url);
        hls.attachMedia(elements.video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          elements.video.play().catch(() => log("浏览器阻止了自动播放，请手动点击播放按钮"));
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => handleHlsError(data));
        return;
      }

      if (elements.video.canPlayType("application/vnd.apple.mpegurl")) {
        elements.video.src = url;
        await elements.video.play().catch(() => log("浏览器阻止了自动播放，请手动点击播放按钮"));
        return;
      }

      throw new Error("当前浏览器不支持 HLS，且 hls.js 未能加载");
    }

    elements.video.src = url;
    await elements.video.play().catch(() => log("浏览器阻止了自动播放，请手动点击播放按钮"));
  }

  async function handleHlsError(data) {
    if (!data?.fatal) return;
    log(`HLS 严重错误：${data.type}`, data.details);

    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && tryNextMediaCandidate()) return;

    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && state.hls) {
      log("尝试恢复媒体解码");
      state.hls.recoverMediaError();
      return;
    }

    destroyHls();
    setBadge("播放失败", "error");
  }

  function tryNextMediaCandidate() {
    const nextIndex = state.mediaCandidateIndex + 1;
    if (nextIndex >= state.mediaCandidates.length) return false;
    state.mediaCandidateIndex = nextIndex;
    const nextUrl = state.mediaCandidates[nextIndex];
    state.currentUrl = nextUrl;
    log(`当前资源线路失败，切换到第 ${nextIndex + 1} 条`, nextUrl);
    attachSource(nextUrl).catch((error) => log("备用资源线路播放失败", error.message));
    return true;
  }

  async function playVideo(video) {
    const candidates = buildMediaCandidates(video);
    if (!candidates.length) {
      log("视频没有可解析的播放地址", video);
      return;
    }

    state.activeVideoId = video.id;
    state.mediaCandidates = candidates;
    state.mediaCandidateIndex = 0;
    state.currentUrl = candidates[0];
    elements.nowTitle.textContent = video.title;
    elements.video.poster = resolvePoster(video.poster);
    elements.playerEmpty.classList.add("hidden");
    elements.copyUrl.disabled = false;
    renderVideoList();
    log(`开始播放：${video.title}`, candidates);

    try {
      await attachSource(state.currentUrl);
    } catch (error) {
      if (!tryNextMediaCandidate()) {
        setBadge("播放失败", "error");
        log("无法播放该视频", error.message);
      }
    }
  }

  async function playManualUrl(url) {
    const normalized = String(url || "").trim();
    try {
      const absolute = new URL(normalized).href;
      await playVideo({
        id: `manual-${Date.now()}`,
        title: "手动地址",
        url: absolute,
        poster: "",
        description: ""
      });
    } catch {
      log("请输入完整的 http/https 视频地址");
    }
  }

  function restoreCandidates() {
    const storageKey = config.storageKeys?.candidates || "video-player-api-candidates";
    const saved = localStorage.getItem(storageKey);
    const initial = saved || (Array.isArray(config.apiCandidates) ? config.apiCandidates.join("\n") : "");
    elements.candidates.value = initial;
  }

  function bindEvents() {
    elements.probeButton.addEventListener("click", selectBestApi);
    elements.reloadCatalog.addEventListener("click", loadCatalog);
    elements.manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      playManualUrl(elements.manualUrl.value);
    });
    elements.copyUrl.addEventListener("click", async () => {
      if (!state.currentUrl) return;
      try {
        await navigator.clipboard.writeText(state.currentUrl);
        log("播放地址已复制");
      } catch {
        elements.manualUrl.value = state.currentUrl;
        elements.manualUrl.select();
        log("无法调用剪贴板，地址已放入输入框");
      }
    });
    elements.video.addEventListener("error", () => {
      if (tryNextMediaCandidate()) return;
      const mediaError = elements.video.error;
      log("浏览器视频元素报错", mediaError ? { code: mediaError.code, message: mediaError.message } : "未知错误");
    });
  }

  async function initialize() {
    elements.appTitle.textContent = config.appName || "视频线路播放器";
    document.title = config.appName || "视频线路播放器";
    restoreCandidates();
    bindEvents();
    await loadCatalog();
    if (getCandidateLines().length) {
      log("已读取保存的 API 线路，可点击“测速选择”连接");
    }
  }

  initialize().catch((error) => {
    setBadge("初始化失败", "error");
    log("应用初始化失败", error.message);
  });
})();
