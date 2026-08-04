(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const state = {
    activeApi: "",
    activeResource: "",
    activeLatency: 0,
    token: "",
    page: 1,
    pageSize: Number(config.defaultVideoParams?.pageSize || 10),
    categoryId: "",
    items: [],
    activeIndex: -1,
    hls: null,
    playlistBlobUrl: "",
    mediaKeyBlobUrl: "",
    observer: null,
    imageCache: new Map(),
    imageResultCache: new Map(),
    resourceBases: [],
    activeAuthor: null,
    authorPage: 1,
    liked: new Set(),
    collected: new Set(),
    loadingMore: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const nativeFetch = window.fetch.bind(window);

  const elements = {
    feed: $("#feed"),
    empty: $("#feed-empty"),
    emptyDetail: $("#feed-empty-detail"),
    status: $("#connection-status"),
    category: $("#category-select"),
    refresh: $("#refresh-button"),
    previous: $("#previous-video"),
    next: $("#next-video"),
    modal: $("#author-modal"),
    authorAvatar: $("#author-avatar"),
    authorName: $("#author-name"),
    authorUid: $("#author-uid"),
    authorIntro: $("#author-intro"),
    authorStats: $("#author-stats"),
    authorWorks: $("#author-works"),
    authorWorkStatus: $("#author-work-status"),
    authorMore: $("#author-more"),
    authorRefresh: $("#author-refresh"),
    toast: $("#toast"),
    activeApi: $("#active-api"),
    activeResource: $("#active-resource")
  };

  function setStatus(text, kind = "busy") {
    elements.status.textContent = text;
    elements.status.className = `connection-status ${kind}`;
    if (elements.emptyDetail && elements.empty && !elements.empty.hidden) {
      elements.emptyDetail.textContent = text;
    }
  }

  let toastTimer = 0;
  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2400);
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
    const normalized = normalizeBase(base);
    if (!normalized) throw new Error(`无效基础地址：${base}`);
    return new URL(String(path || "").replace(/^\/+/, ""), normalized).href;
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function formatCount(value) {
    const number = Number(value || 0);
    if (number >= 100000000) return `${(number / 100000000).toFixed(number >= 1000000000 ? 0 : 1)}亿`;
    if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
    return String(number);
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Number(value || 0));
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function placeholderAvatar() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='100%25' height='100%25' rx='80' fill='%23232323'/%3E%3Ccircle cx='80' cy='60' r='27' fill='%23dedede'/%3E%3Cpath d='M26 150c7-37 28-55 54-55s47 18 54 55' fill='%23dedede'/%3E%3C/svg%3E";
  }

  function placeholderCover() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='900'%3E%3Crect width='100%25' height='100%25' fill='%23141414'/%3E%3Ccircle cx='300' cy='450' r='70' fill='%23fe2c55' opacity='.85'/%3E%3Cpath d='M276 405l82 45-82 45z' fill='white'/%3E%3C/svg%3E";
  }

  function getOrCreateUuid() {
    const key = config.storageKeys?.uuid || "hq-video-device-uuid";
    let uuid = localStorage.getItem(key) || "";
    if (uuid) return uuid;
    if (crypto?.randomUUID) uuid = crypto.randomUUID();
    else {
      const values = crypto.getRandomValues(new Uint32Array(4));
      uuid = `${Date.now().toString(16)}-${[...values].map((value) => value.toString(16)).join("-")}`;
    }
    localStorage.setItem(key, uuid);
    return uuid;
  }

  function setToken(token) {
    state.token = String(token || "").trim();
    const key = config.storageKeys?.token || "hq-video-token";
    if (state.token) localStorage.setItem(key, state.token);
    else localStorage.removeItem(key);
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function wordArrayToBytes(wordArray) {
    const words = wordArray.words || [];
    const length = wordArray.sigBytes || 0;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
    }
    return bytes;
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
    return "";
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
    if (!compressedBase64) throw new Error("接口 AES 解密结果为空");
    const jsonText = pako.inflate(base64ToBytes(compressedBase64), { to: "string" });
    return JSON.parse(jsonText);
  }

  function decodeEnvelope(body) {
    if (!body || typeof body !== "object") return body;
    const decoded = Array.isArray(body) ? [...body] : { ...body };
    if (typeof decoded.data === "string" && decoded.data) decoded.data = decryptResponseData(decoded.data);
    return decoded;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = Number(config.requestTimeoutMs || 10000)) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await nativeFetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        ...options,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    return decodeEnvelope(JSON.parse(text));
  }

  function headers(token = state.token) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      t: "2",
      k: "2",
      token: token || "",
      version: String(config.webVersion || "1.2.75")
    };
  }

  async function apiRequest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const base = options.base || state.activeApi;
    if (!base) throw new Error("API 线路尚未初始化");
    const url = new URL(joinUrl(base, path));
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const request = { method, headers: headers(options.token) };
    if (method !== "GET" && method !== "HEAD") {
      request.body = JSON.stringify({ en: encryptRequest(options.data || {}) });
    }
    const response = await fetchWithTimeout(url.href, request, options.timeoutMs || 15000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = await parseJsonResponse(response);
    const code = Number(decoded?.errorCode ?? decoded?.code ?? 0);
    if (code !== 0) {
      const error = new Error(decoded?.message || decoded?.msg || `errorCode ${code}`);
      error.code = code;
      throw error;
    }
    return decoded;
  }

  function latencyScore(milliseconds) {
    if (milliseconds <= 100) return 10;
    if (milliseconds <= 250) return 7;
    if (milliseconds <= 500) return 5;
    if (milliseconds <= 700) return 3;
    if (milliseconds <= 1000) return 1;
    return 0;
  }

  async function probeApi(base) {
    const started = performance.now();
    const response = await fetchWithTimeout(joinUrl(base, config.speedtestPath || "speedtest"), {
      headers: { Accept: "application/json" }
    }, 6500);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = await parseJsonResponse(response);
    const elapsed = Math.round(performance.now() - started);
    const serverScore = Number(decoded?.data?.s ?? decoded?.s ?? 0);
    return {
      base,
      elapsed,
      serverScore,
      weightedScore: serverScore * 0.75 + latencyScore(elapsed) * 0.25
    };
  }

  async function chooseApi(candidates) {
    const normalized = unique(candidates.map(normalizeBase));
    const settled = await Promise.allSettled(normalized.map(probeApi));
    const successful = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
    if (!successful.length) throw new Error("所有 API 线路均不可访问");
    const preferred = successful
      .filter((item) => item.serverScore >= 5)
      .sort((left, right) => left.elapsed - right.elapsed)[0];
    const winner = preferred || successful.sort((left, right) => {
      return right.weightedScore - left.weightedScore || left.elapsed - right.elapsed;
    })[0];
    state.activeApi = winner.base;
    state.activeLatency = winner.elapsed;
    elements.activeApi.textContent = winner.base;
    return winner;
  }

  function flattenDomainValues(value) {
    if (Array.isArray(value)) return value.flatMap(flattenDomainValues);
    if (typeof value === "string") return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).flatMap(flattenDomainValues);
    return [];
  }

  async function loadDomainConfig() {
    const result = await apiRequest(config.domainConfigPath || "sys/dmCfg", {
      params: { pid: config.pid || "PH" },
      token: ""
    });
    const payload = result?.data ?? result;
    const apiDomains = flattenDomainValues(payload?.apiDomains || payload?.apiUrls || []);
    const resourceDomains = flattenDomainValues(
      payload?.resDomains || payload?.resourceDomains || payload?.resourceUrls || payload?.resUrls || []
    ).map(normalizeBase);
    state.resourceBases = unique(resourceDomains);
    state.activeResource = state.resourceBases[0] || "";
    elements.activeResource.textContent = state.activeResource;
    if (apiDomains.length && config.useDynamicApiDomains !== false) {
      try {
        await chooseApi(unique([state.activeApi, ...apiDomains]));
      } catch {
        // 保留引导 API。
      }
    }
  }

  async function validateToken() {
    if (!state.token) return false;
    try {
      await apiRequest(config.userInfoPath || "users/info");
      return true;
    } catch {
      setToken("");
      return false;
    }
  }

  async function signin() {
    const result = await apiRequest(config.signinPath || "users/signin", {
      method: "POST",
      token: "",
      data: {
        verifyType: "anonymous",
        uuid: getOrCreateUuid(),
        channel: config.defaultChannel || "",
        inviteCode: config.defaultInviteCode || "",
        captcha: localStorage.getItem(config.storageKeys?.captchaCode || "hq-video-captcha-code") || "",
        key: localStorage.getItem(config.storageKeys?.captchaKey || "hq-video-captcha-key") || "",
        pid: config.pid || "PH",
        url: location.href
      }
    });
    const token = result?.data?.resToken?.token || "";
    if (!token) throw new Error("游客登录未返回 Token");
    setToken(token);
  }

  async function ensureAuthenticated() {
    const queryToken = new URL(location.href).searchParams.get("token");
    setToken(queryToken || localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "");
    if (await validateToken()) return;
    await signin();
  }

  function findArray(value, depth = 0) {
    if (depth > 6 || value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];
    for (const key of ["videoInfo", "contents", "videos", "list", "items", "records", "rows", "data"]) {
      if (value[key] !== undefined) {
        const result = findArray(value[key], depth + 1);
        if (result.length) return result;
      }
    }
    return [];
  }

  function videoOf(item) {
    return item?.video && typeof item.video === "object" ? item.video : item || {};
  }

  function videoId(item) {
    const video = videoOf(item);
    return String(video.id ?? video.vid ?? video.videoId ?? item?.id ?? "");
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
          // 尝试下一条线路。
        }
      }
    }
    return "";
  }

  function appendPlaybackParams(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      if (config.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", config.pid);
      if (state.activeResource && !url.searchParams.has("domain")) url.searchParams.set("domain", state.activeResource);
      return url.href;
    } catch {
      return value;
    }
  }

  function normalizeItem(item, index) {
    const video = videoOf(item);
    const rawUrl = item?.url || video.url || video.playUrl || video.playURL || video.videoUrl || video.videoURL || "";
    const resolvedUrl = resolveUrl(rawUrl, [state.activeApi, state.activeResource]);
    const coverPath = video.verticalCoverURL || video.coverURL || video.coverUrl || video.cover || video.poster || "";
    const user = video.user || item?.user || {
      uid: video.publisherId || item?.publisherId,
      username: video.publisherName || "未知作者",
      avatarURL: video.publisherAvatar || ""
    };
    return {
      id: videoId(item) || `video-${state.page}-${index}`,
      title: String(video.name || video.title || video.description || `视频 ${index + 1}`),
      url: item?.video ? appendPlaybackParams(resolvedUrl) : resolvedUrl,
      coverPath,
      duration: Number(video.time || video.duration || 0),
      playCnt: Number(video.playCnt || 0),
      likedCnt: Number(video.likedCnt || 0),
      commentCnt: Number(video.commentCnt || 0),
      collectedCnt: Number(video.collectedCnt || 0),
      user,
      protectedPlaylist: Boolean(item?.video) || !/\.(mp4|webm|ogg)(?:$|[?#])/i.test(resolvedUrl),
      raw: item
    };
  }

  async function loadCategories() {
    try {
      const result = await apiRequest(config.shortCategoryPath || "videos/shortCate", {
        params: { pid: config.pid || "PH" }
      });
      const categories = findArray(result?.data ?? result);
      elements.category.replaceChildren(new Option("全部", ""));
      categories.forEach((category) => {
        const id = category.id ?? category.categorieId ?? category.categoryId ?? category.cid;
        const name = category.name || category.title || category.categorieName || category.categoryName;
        if (id !== undefined && name) elements.category.append(new Option(String(name), String(id)));
      });
    } catch {
      elements.category.replaceChildren(new Option("全部", ""));
    }
  }

  async function loadVideos({ reset = false } = {}) {
    if (state.loadingMore) return;
    state.loadingMore = true;
    if (reset) {
      state.page = 1;
      state.items = [];
      state.activeIndex = -1;
      elements.feed.replaceChildren(elements.empty);
      elements.empty.hidden = false;
    }
    setStatus(`正在加载第 ${state.page} 页…`, "busy");
    try {
      const params = {
        ...(config.defaultVideoParams || {}),
        page: state.page,
        pageSize: state.pageSize,
        categorieId: state.categoryId,
        pid: config.pid || "PH"
      };
      const result = await apiRequest(config.videoCatalogPath || "videos/short", { params });
      const list = findArray(result?.data ?? result);
      const nextItems = list.map(normalizeItem).filter((item) => item.url);
      if (reset) state.items = nextItems;
      else state.items.push(...nextItems);
      renderFeed(reset ? 0 : state.items.length - nextItems.length);
      state.page += 1;
      setStatus(`已连接 · ${state.activeLatency} ms`, "ok");
      if (!state.items.length) showEmpty("服务器没有返回可播放视频");
    } catch (error) {
      if (!state.items.length) showEmpty(`加载失败：${error.message}`);
      setStatus(`加载失败：${error.message}`, "error");
    } finally {
      state.loadingMore = false;
    }
  }

  function showEmpty(message) {
    elements.feed.replaceChildren(elements.empty);
    elements.empty.hidden = false;
    elements.emptyDetail.textContent = message;
  }

  function assetCandidates(path, size = 0) {
    const raw = String(path || "").trim();
    if (!raw) return [];
    if (/^data:image\//i.test(raw) || /^blob:/i.test(raw)) return [raw];
    const absolute = /^https?:\/\//i.test(raw);
    const bases = absolute ? [""] : unique([state.activeResource, ...state.resourceBases, state.activeApi]);
    const candidates = [];
    for (const base of bases) {
      try {
        const original = absolute ? new URL(raw).href : joinUrl(base, raw);
        if (size && /\.(ceb|geb)(?:$|[?#])/i.test(original) && !/@(?:webp|png)-\d+/i.test(original)) {
          candidates.push(`${original}@webp-${size}`);
        }
        candidates.push(original);
      } catch {
        // 尝试下一条线路。
      }
    }
    return unique(candidates);
  }

  async function decryptImage(url) {
    if (state.imageResultCache.has(url)) return state.imageResultCache.get(url);
    if (state.imageCache.has(url)) return state.imageCache.get(url);
    const promise = (async () => {
      const response = await nativeFetch(url, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      const rawMime = contentType.startsWith("image/") ? contentType.split(";")[0] : detectImageMime(bytes);
      if (rawMime) return URL.createObjectURL(new Blob([bytes], { type: rawMime }));

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
      if (text && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
        const clean = text.replace(/\s+/g, "");
        try {
          const decoded = base64ToBytes(clean);
          return `data:${detectImageMime(decoded) || "image/webp"};base64,${clean}`;
        } catch {
          // 继续按二进制图片处理。
        }
      }
      const plainBytes = wordArrayToBytes(decrypted);
      const mime = detectImageMime(plainBytes);
      if (!mime) throw new Error("图片解密结果不可识别");
      return URL.createObjectURL(new Blob([plainBytes], { type: mime }));
    })().then((src) => {
      state.imageResultCache.set(url, src);
      return src;
    });
    state.imageCache.set(url, promise);
    return promise;
  }

  async function setImage(img, path, size = 480) {
    if (!img || !path) return;
    const candidates = assetCandidates(path, size);
    for (const candidate of candidates) {
      try {
        const encrypted = /\.(ceb|geb)(?:@[^/?#]+)?(?:$|[?#])/i.test(candidate);
        const src = encrypted ? await decryptImage(candidate) : candidate;
        await new Promise((resolve, reject) => {
          const probe = new Image();
          probe.onload = resolve;
          probe.onerror = reject;
          probe.src = src;
        });
        img.src = src;
        return;
      } catch {
        // 尝试下一条线路。
      }
    }
  }

  function createAction(label, icon, value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button";
    button.innerHTML = `<span class="action-icon"></span><strong></strong>`;
    $(".action-icon", button).textContent = icon;
    $("strong", button).textContent = value;
    button.setAttribute("aria-label", label);
    return button;
  }

  function renderFeed(startIndex = 0) {
    elements.empty.hidden = true;
    if (startIndex === 0) {
      destroyPlayer();
      elements.feed.replaceChildren();
      state.observer?.disconnect();
      state.observer = new IntersectionObserver(onSlideVisibility, {
        root: elements.feed,
        threshold: [0.55, 0.8]
      });
    }

    state.items.slice(startIndex).forEach((item, offset) => {
      const index = startIndex + offset;
      const slide = document.createElement("article");
      slide.className = "video-slide";
      slide.dataset.index = String(index);
      slide.dataset.videoId = item.id;

      const backdrop = document.createElement("img");
      backdrop.className = "video-backdrop";
      backdrop.alt = "";
      backdrop.src = placeholderCover();

      const mask = document.createElement("div");
      mask.className = "video-backdrop-mask";

      const stage = document.createElement("div");
      stage.className = "video-stage";
      const video = document.createElement("video");
      video.playsInline = true;
      video.loop = true;
      video.preload = index < 2 ? "metadata" : "none";
      video.poster = placeholderCover();
      video.setAttribute("webkit-playsinline", "");
      video.addEventListener("click", () => {
        if (video.paused) video.play().catch(() => undefined);
        else video.pause();
      });
      video.addEventListener("dblclick", () => toggleLike(item, slide));

      const loading = document.createElement("div");
      loading.className = "video-loading";
      loading.innerHTML = '<div class="loading-ring"></div><span>正在加载视频…</span>';

      const error = document.createElement("div");
      error.className = "video-error";
      error.hidden = true;
      error.innerHTML = '<strong>视频加载失败</strong><span></span><button type="button" class="icon-button">重试</button>';
      $(".icon-button", error).addEventListener("click", () => activateSlide(index, true));

      stage.append(video, loading, error);

      const copy = document.createElement("div");
      copy.className = "video-copy";
      const authorLine = document.createElement("button");
      authorLine.type = "button";
      authorLine.className = "author-line";
      authorLine.innerHTML = '<img alt="作者头像"><strong></strong><span>主页</span>';
      const authorAvatar = $("img", authorLine);
      authorAvatar.src = placeholderAvatar();
      $("strong", authorLine).textContent = item.user?.username || "未知作者";
      authorLine.addEventListener("click", () => openAuthor(item.user));

      const title = document.createElement("p");
      title.className = "video-title";
      title.textContent = item.title;
      const tags = document.createElement("p");
      tags.className = "video-tags";
      tags.textContent = `#短视频  ${item.duration ? formatDuration(item.duration) : ""}`.trim();
      copy.append(authorLine, title, tags);

      const actions = document.createElement("div");
      actions.className = "action-column";
      const authorAction = document.createElement("button");
      authorAction.type = "button";
      authorAction.className = "action-button author-action";
      authorAction.innerHTML = '<img alt="作者头像"><strong>作者</strong>';
      const actionAvatar = $("img", authorAction);
      actionAvatar.src = placeholderAvatar();
      authorAction.addEventListener("click", () => openAuthor(item.user));

      const like = createAction("点赞", "♥", formatCount(item.likedCnt));
      like.dataset.action = "like";
      like.addEventListener("click", () => toggleLike(item, slide));

      const comment = createAction("评论", "◌", formatCount(item.commentCnt));
      comment.addEventListener("click", () => toast("评论接口暂未接入，当前先展示评论数量"));

      const collect = createAction("收藏", "★", formatCount(item.collectedCnt));
      collect.dataset.action = "collect";
      collect.addEventListener("click", () => toggleCollect(item, slide));

      const share = createAction("分享", "↗", "分享");
      share.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(location.href.split("#")[0] + `#video-${item.id}`);
          toast("视频链接已复制");
        } catch {
          toast("浏览器未允许复制链接");
        }
      });

      actions.append(authorAction, like, comment, collect, share);
      slide.append(backdrop, mask, stage, copy, actions);
      elements.feed.append(slide);

      setImage(backdrop, item.coverPath, 720).then(() => {
        video.poster = backdrop.src || placeholderCover();
      }).catch(() => undefined);
      setImage(authorAvatar, item.user?.avatarURL, 120);
      setImage(actionAvatar, item.user?.avatarURL, 120);
      state.observer.observe(slide);
    });

    if (startIndex === 0 && state.items.length) {
      requestAnimationFrame(() => scrollToIndex(0, false));
    }
  }

  function toggleLike(item, slide) {
    if (state.liked.has(item.id)) state.liked.delete(item.id);
    else state.liked.add(item.id);
    const button = $('[data-action="like"]', slide);
    button?.classList.toggle("active", state.liked.has(item.id));
    $("strong", button).textContent = formatCount(item.likedCnt + (state.liked.has(item.id) ? 1 : 0));
  }

  function toggleCollect(item, slide) {
    if (state.collected.has(item.id)) state.collected.delete(item.id);
    else state.collected.add(item.id);
    const button = $('[data-action="collect"]', slide);
    button?.classList.toggle("active", state.collected.has(item.id));
    $("strong", button).textContent = formatCount(item.collectedCnt + (state.collected.has(item.id) ? 1 : 0));
  }

  function onSlideVisibility(entries) {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible || visible.intersectionRatio < 0.55) return;
    const index = Number(visible.target.dataset.index);
    if (index !== state.activeIndex) activateSlide(index);
  }

  function destroyPlayer() {
    state.hls?.destroy();
    state.hls = null;
    if (state.playlistBlobUrl) URL.revokeObjectURL(state.playlistBlobUrl);
    state.playlistBlobUrl = "";
    $$(".video-slide video").forEach((video) => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    });
  }

  function getMediaKeyBlobUrl() {
    if (!state.mediaKeyBlobUrl) {
      state.mediaKeyBlobUrl = URL.createObjectURL(new Blob([base64ToBytes(config.mediaKeyBase64)], {
        type: "application/octet-stream"
      }));
    }
    return state.mediaKeyBlobUrl;
  }

  function rewritePlaylist(playlist, sourceUrl) {
    const keyUrl = getMediaKeyBlobUrl();
    return playlist.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#EXT-X-KEY")) {
        if (/URI="[^"]*"/i.test(line)) return line.replace(/URI="[^"]*"/i, `URI="${keyUrl}"`);
        return `${line},URI="${keyUrl}"`;
      }
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
          try {
            return `URI="${new URL(uri, sourceUrl).href}"`;
          } catch {
            return match;
          }
        });
      }
      try {
        return new URL(trimmed, sourceUrl).href;
      } catch {
        return line;
      }
    }).join("\n");
  }

  async function fetchProtectedPlaylist(url) {
    const response = await fetchWithTimeout(url, { headers: { m: "1" } }, 15000);
    if (!response.ok) throw new Error(`播放列表 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let playlist = "";
    try {
      playlist = pako.inflate(bytes, { to: "string" });
    } catch {
      playlist = new TextDecoder("utf-8").decode(bytes);
    }
    if (!playlist.includes("#EXTM3U")) throw new Error("服务器没有返回有效 HLS 播放列表");
    return rewritePlaylist(playlist, url);
  }

  async function attachHls(video, source) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
      await video.play();
      return;
    }
    if (!Hls.isSupported()) throw new Error("当前浏览器不支持 HLS/MSE");
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 45 });
    state.hls = hls;
    await new Promise((resolve, reject) => {
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source));
      hls.on(Hls.Events.MANIFEST_PARSED, resolve);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else reject(new Error(data.details || "HLS 播放失败"));
      });
    });
    await video.play();
  }

  async function activateSlide(index, force = false) {
    if (!force && index === state.activeIndex) return;
    const slide = $(`.video-slide[data-index="${index}"]`);
    const item = state.items[index];
    if (!slide || !item) return;

    state.hls?.destroy();
    state.hls = null;
    if (state.playlistBlobUrl) URL.revokeObjectURL(state.playlistBlobUrl);
    state.playlistBlobUrl = "";

    $$(".video-slide video").forEach((video, videoIndex) => {
      if (videoIndex !== index) video.pause();
    });
    state.activeIndex = index;

    const video = $("video", slide);
    const loading = $(".video-loading", slide);
    const error = $(".video-error", slide);
    loading.hidden = false;
    error.hidden = true;

    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
      let source = item.url;
      if (item.protectedPlaylist) {
        const playlist = await fetchProtectedPlaylist(item.url);
        state.playlistBlobUrl = URL.createObjectURL(new Blob([playlist], {
          type: "application/vnd.apple.mpegurl"
        }));
        source = state.playlistBlobUrl;
      }
      if (/\.m3u8(?:$|[?#])/i.test(source) || source.startsWith("blob:")) {
        await attachHls(video, source);
      } else {
        video.src = source;
        await video.play();
      }
      loading.hidden = true;
      history.replaceState(null, "", `#video-${item.id}`);
      if (index >= state.items.length - 3) loadVideos();
    } catch (playError) {
      loading.hidden = true;
      error.hidden = false;
      $("span", error).textContent = playError.message;
    }
  }

  function scrollToIndex(index, smooth = true) {
    const safe = Math.max(0, Math.min(state.items.length - 1, index));
    const slide = $(`.video-slide[data-index="${safe}"]`);
    slide?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  async function openAuthor(user) {
    const uid = user?.uid ?? user?.id;
    if (!uid) {
      toast("该视频没有作者 UID");
      return;
    }
    state.activeAuthor = { ...user, uid };
    state.authorPage = 1;
    elements.modal.hidden = false;
    renderAuthorHeader(state.activeAuthor);
    elements.authorWorks.replaceChildren();
    elements.authorWorkStatus.textContent = "正在加载作者资料…";
    try {
      const result = await apiRequest(
        (config.authorInfoPath || "users/{uid}/info").replace("{uid}", encodeURIComponent(uid)),
        { params: { pid: config.pid || "PH" } }
      );
      const author = result?.data?.user || result?.data || state.activeAuthor;
      state.activeAuthor = { ...state.activeAuthor, ...author, uid: author.uid ?? uid };
      renderAuthorHeader(state.activeAuthor);
    } catch (error) {
      elements.authorIntro.textContent = `${state.activeAuthor.introduce || "暂无简介"}（资料加载失败：${error.message}）`;
    }
    await loadAuthorWorks(1, false);
  }

  function closeAuthor() {
    elements.modal.hidden = true;
  }

  function renderAuthorHeader(author) {
    elements.authorName.textContent = author?.username || "未知作者";
    elements.authorUid.textContent = `UID ${author?.uid ?? author?.id ?? "—"}`;
    elements.authorIntro.textContent = author?.introduce || "暂无简介";
    elements.authorAvatar.src = placeholderAvatar();
    setImage(elements.authorAvatar, author?.avatarURL, 240);
    const values = [
      ["作品", author?.videoCnt],
      ["粉丝", author?.followerCnt],
      ["获赞", author?.likedCnt],
      ["收藏", author?.collectCnt]
    ];
    elements.authorStats.replaceChildren(...values.map(([label, value]) => {
      const node = document.createElement("div");
      node.className = "author-stat";
      node.innerHTML = "<strong></strong><span></span>";
      $("strong", node).textContent = formatCount(value);
      $("span", node).textContent = label;
      return node;
    }));
  }

  async function loadAuthorWorks(page = 1, append = false) {
    const uid = state.activeAuthor?.uid ?? state.activeAuthor?.id;
    if (!uid) return;
    elements.authorMore.disabled = true;
    elements.authorWorkStatus.textContent = `正在加载第 ${page} 页…`;
    try {
      const result = await apiRequest(
        (config.authorVideosPath || "users/{uid}/videos").replace("{uid}", encodeURIComponent(uid)),
        {
          params: {
            timeType: 3,
            page,
            pageSize: Number(config.authorPageSize || 12),
            pid: config.pid || "PH"
          }
        }
      );
      const works = findArray(result?.data ?? result);
      if (!append) elements.authorWorks.replaceChildren();
      works.forEach(renderAuthorWork);
      state.authorPage = page;
      elements.authorWorkStatus.textContent = works.length ? `第 ${page} 页 · ${works.length} 条` : "没有更多作品";
      elements.authorMore.hidden = works.length < Number(config.authorPageSize || 12);
    } catch (error) {
      elements.authorWorkStatus.textContent = `作品加载失败：${error.message}`;
    } finally {
      elements.authorMore.disabled = false;
    }
  }

  function renderAuthorWork(rawItem) {
    const item = normalizeItem(rawItem, elements.authorWorks.children.length);
    const video = videoOf(rawItem);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "author-work";
    button.innerHTML = '<img alt=""><div class="author-work-copy"><strong></strong><span></span></div>';
    const image = $("img", button);
    image.src = placeholderCover();
    $("strong", button).textContent = video.name || video.title || item.title || "未命名视频";
    $("span", button).textContent = `▶ ${formatCount(video.playCnt)}  ♥ ${formatCount(video.likedCnt)}`;
    setImage(image, video.verticalCoverURL || video.coverURL || item.coverPath, 480);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const playable = await getPlayableItem(rawItem);
        const normalized = normalizeItem(playable, 0);
        const existing = state.items.findIndex((entry) => entry.id === normalized.id);
        let targetIndex = existing;
        if (existing < 0) {
          state.items.unshift(normalized);
          renderFeed(0);
          targetIndex = 0;
        }
        closeAuthor();
        requestAnimationFrame(() => scrollToIndex(targetIndex));
      } catch (error) {
        toast(`无法加载该作品：${error.message}`);
      } finally {
        button.disabled = false;
      }
    });
    elements.authorWorks.append(button);
  }

  async function getPlayableItem(item) {
    if (item?.url) return item;
    const video = videoOf(item);
    if (video.url) return { video, url: video.url };
    const id = videoId(item);
    if (!id) throw new Error("作品缺少视频 ID");
    const paths = [`shortVideos/${encodeURIComponent(id)}`, `newsVideos/${encodeURIComponent(id)}`];
    let lastError;
    for (const path of paths) {
      try {
        const result = await apiRequest(path, { params: { pid: config.pid || "PH" } });
        const payload = result?.data || {};
        const candidate = payload.video || payload;
        const url = payload.url || candidate.url || candidate.playURL || candidate.playUrl;
        if (url) return { video: { ...video, ...candidate }, url };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("服务器没有返回播放地址");
  }

  async function initialize() {
    try {
      if (!window.CryptoJS || !window.pako || !window.Hls) throw new Error("页面依赖没有加载完成");
      setStatus("正在测速 API…", "busy");
      const storageKey = config.storageKeys?.apiCandidates || "hq-video-api-candidates";
      const stored = localStorage.getItem(storageKey);
      await chooseApi(stored ? stored.split(/\n+/) : (config.apiCandidates || []));
      setStatus("正在获取资源线路…", "busy");
      await loadDomainConfig();
      setStatus("正在游客登录…", "busy");
      await ensureAuthenticated();
      await loadCategories();
      await loadVideos({ reset: true });
    } catch (error) {
      showEmpty(`初始化失败：${error.message}`);
      setStatus(`初始化失败：${error.message}`, "error");
    }
  }

  function setActiveNavigation(mode) {
    $$(".feed-tab").forEach((button) => button.classList.toggle("active", button.dataset.feedTab === mode));
    $$(".rail-item[data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === mode));
    $$(".mobile-nav button").forEach((button) => button.classList.toggle("active", button.dataset.mobileNav === mode));
    if (mode === "latest") {
      state.items.reverse();
      renderFeed(0);
    } else if (mode === "liked") {
      toast("已点赞的视频会在当前浏览会话中高亮显示");
    }
  }

  function bindEvents() {
    elements.refresh.addEventListener("click", () => loadVideos({ reset: true }));
    elements.category.addEventListener("change", () => {
      state.categoryId = elements.category.value;
      loadVideos({ reset: true });
    });
    elements.previous.addEventListener("click", () => scrollToIndex(state.activeIndex - 1));
    elements.next.addEventListener("click", () => scrollToIndex(state.activeIndex + 1));

    $$(".feed-tab").forEach((button) => {
      button.addEventListener("click", () => setActiveNavigation(button.dataset.feedTab));
    });
    $$(".rail-item[data-nav]").forEach((button) => {
      button.addEventListener("click", () => setActiveNavigation(button.dataset.nav));
    });
    $$(".mobile-nav button[data-mobile-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.mobileNav;
        if (mode === "profile") toast("当前使用游客身份");
        else setActiveNavigation(mode);
      });
    });

    $$('[data-close-author]').forEach((button) => button.addEventListener("click", closeAuthor));
    elements.authorMore.addEventListener("click", () => loadAuthorWorks(state.authorPage + 1, true));
    elements.authorRefresh.addEventListener("click", () => {
      if (state.activeAuthor) openAuthor(state.activeAuthor);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        scrollToIndex(state.activeIndex + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        scrollToIndex(state.activeIndex - 1);
      } else if (event.key === "Escape" && !elements.modal.hidden) {
        closeAuthor();
      } else if (event.code === "Space" && elements.modal.hidden) {
        const video = $(`.video-slide[data-index="${state.activeIndex}"] video`);
        if (video) {
          event.preventDefault();
          if (video.paused) video.play().catch(() => undefined);
          else video.pause();
        }
      }
    });

    window.addEventListener("beforeunload", () => {
      destroyPlayer();
      if (state.mediaKeyBlobUrl) URL.revokeObjectURL(state.mediaKeyBlobUrl);
    });
  }

  bindEvents();
  initialize();
})();
