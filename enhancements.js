(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const apiFetch = window.fetch.bind(window);
  const binaryFetch = window.__nativeFetch || window.fetch.bind(window);
  const state = {
    videoItems: [],
    videosById: new Map(),
    currentVideo: null,
    imageCache: new Map(),
    imageResults: new Map(),
    imageFailures: new Map(),
    resourceBases: [],
    authorPage: 1,
    activeAuthor: null,
    enhancing: false,
    downloadAbort: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function normalizeBase(value) {
    const text = String(value || "").trim();
    if (!text || text === "—") return "";
    try {
      const url = new URL(text);
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function joinUrl(base, path) {
    return new URL(String(path || "").replace(/^\/+/, ""), normalizeBase(base)).href;
  }

  function currentApi() {
    return normalizeBase($("#active-api")?.textContent);
  }

  function currentResource() {
    return normalizeBase($("#active-resource")?.textContent);
  }

  function currentToken() {
    return localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "";
  }

  function apiHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      t: "2",
      k: "2",
      token: currentToken(),
      version: String(config.webVersion || "1.2.75")
    };
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function decryptEnvelope(body) {
    if (!body || typeof body !== "object") return body;
    if (typeof body.data !== "string" || !body.data) return body;
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const decrypted = CryptoJS.AES.decrypt(body.data, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
    if (!compressedBase64) throw new Error("接口 AES 解密结果为空");
    const jsonText = pako.inflate(base64ToBytes(compressedBase64), { to: "string" });
    return { ...body, data: JSON.parse(jsonText) };
  }

  async function readJsonResponse(response) {
    const text = await response.clone().text();
    if (!text) return {};
    return decryptEnvelope(JSON.parse(text));
  }

  function findArray(value, depth = 0) {
    if (depth > 6 || value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];
    for (const key of ["videoInfo", "contents", "videos", "list", "items", "records", "rows", "data"]) {
      if (value[key] !== undefined) {
        const found = findArray(value[key], depth + 1);
        if (found.length) return found;
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

  function formatCount(value) {
    const n = Number(value || 0);
    if (n >= 100000000) return `${(n / 100000000).toFixed(n >= 1000000000 ? 0 : 1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
    return String(n);
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Number(value || 0));
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function sanitizeFilename(name) {
    return String(name || "video")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "video";
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function getResourceBases() {
    return unique([
      currentResource(),
      ...state.resourceBases,
      currentApi()
    ].map(normalizeBase));
  }

  function assetCandidates(path, size = 0) {
    const raw = String(path || "").trim();
    if (!raw) return [];
    if (/^data:image\//i.test(raw) || /^blob:/i.test(raw)) return [raw];

    const absolute = /^https?:\/\//i.test(raw);
    const bases = absolute ? [""] : getResourceBases();
    const urls = [];
    for (const base of bases) {
      try {
        const original = absolute ? new URL(raw).href : joinUrl(base, raw);
        if (size && /\.(ceb|geb)(?:$|[?#])/i.test(original) && !/@(?:webp|png)-\d+/i.test(original)) {
          // 与 APK 的 dowloadJpegImg 一致：优先请求 @webp-N，失败后回退原文件。
          urls.push(`${original}@webp-${Number(size) === 240 ? 480 : Number(size)}`);
        }
        urls.push(original);
      } catch {
        // 继续尝试其他资源线路。
      }
    }
    return unique(urls);
  }

  function detectImageMime(bytes) {
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

  function wordArrayToBytes(wordArray) {
    const words = wordArray.words || [];
    const length = wordArray.sigBytes || 0;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return bytes;
  }

  function normalizeDecryptedImage(decrypted) {
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
        const mime = detectImageMime(decoded) || "image/webp";
        return `data:${mime};base64,${clean}`;
      } catch {
        // 继续尝试把解密结果当二进制图片。
      }
    }

    const bytes = wordArrayToBytes(decrypted);
    const mime = detectImageMime(bytes);
    if (mime) return URL.createObjectURL(new Blob([bytes], { type: mime }));
    throw new Error("图片解密结果不是可识别的图片");
  }

  async function decryptCeb(url) {
    if (!url) return "";
    if (state.imageResults.has(url)) return state.imageResults.get(url);
    if (state.imageCache.has(url)) return state.imageCache.get(url);

    const promise = (async () => {
      const response = await binaryFetch(url, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const bytes = new Uint8Array(await response.arrayBuffer());

      // 某些缩略图节点可能直接返回图片，即使 Content-Type 是 octet-stream。
      const rawMime = contentType.startsWith("image/") ? contentType.split(";")[0] : detectImageMime(bytes);
      if (rawMime) return URL.createObjectURL(new Blob([bytes], { type: rawMime }));

      const key = CryptoJS.enc.Utf8.parse(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
      const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
        blockSize: 16
      });
      return normalizeDecryptedImage(decrypted);
    })().then((src) => {
      state.imageResults.set(url, src);
      state.imageFailures.delete(url);
      return src;
    }).catch((error) => {
      state.imageFailures.set(url, error.message || String(error));
      throw error;
    });

    state.imageCache.set(url, promise);
    return promise;
  }

  function preloadImage(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(src);
      probe.onerror = () => reject(new Error("浏览器无法解码图片"));
      probe.src = src;
    });
  }

  const imageQueue = [];
  let activeImageJobs = 0;
  const maxImageJobs = 4;

  function runImageQueue() {
    while (activeImageJobs < maxImageJobs && imageQueue.length) {
      const job = imageQueue.shift();
      activeImageJobs += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeImageJobs -= 1;
          runImageQueue();
        });
    }
  }

  function enqueueImage(task) {
    return new Promise((resolve, reject) => {
      imageQueue.push({ task, resolve, reject });
      runImageQueue();
    });
  }

  async function setEncryptedImage(img, path, size = 0) {
    if (!img || !path) return;
    const candidates = assetCandidates(path, size);
    if (!candidates.length) return;

    const requestKey = `${String(path)}|${size}|${candidates.join("|")}`;
    if (img.dataset.imageRequest === requestKey && ["loading", "loaded", "failed"].includes(img.dataset.imageState)) return;
    img.dataset.imageRequest = requestKey;
    img.dataset.imageState = "loading";

    // 卡片被主播放器重建时，直接复用已解出的图片，避免先显示占位图再闪一下。
    for (const candidate of candidates) {
      const cached = state.imageResults.get(candidate);
      if (cached) {
        img.onerror = null;
        img.src = cached;
        img.dataset.imageState = "loaded";
        return;
      }
    }

    const errors = [];
    await enqueueImage(async () => {
      for (const candidate of candidates) {
        if (img.dataset.imageRequest !== requestKey) return;
        try {
          const encrypted = /\.(ceb|geb)(?:@[^/?#]+)?(?:$|[?#])/i.test(candidate);
          const src = encrypted ? await decryptCeb(candidate) : candidate;
          await preloadImage(src);
          if (img.dataset.imageRequest !== requestKey) return;
          img.onerror = null;
          img.src = src;
          img.dataset.imageState = "loaded";
          img.removeAttribute("data-image-error");
          return;
        } catch (error) {
          errors.push(`${candidate}: ${error.message || error}`);
        }
      }
      if (img.dataset.imageRequest === requestKey) {
        img.dataset.imageState = "failed";
        img.dataset.imageError = errors.join(" | ").slice(0, 1200);
        img.title = "图片加载失败；请检查资源服务器 CORS 或图片解密响应";
      }
    });
  }

  async function requestApi(path, params = {}) {
    const base = currentApi();
    if (!base) throw new Error("API 尚未初始化");
    const url = new URL(joinUrl(base, path));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const response = await apiFetch(url.href, { method: "GET", headers: apiHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = await readJsonResponse(response);
    if (Number(decoded.errorCode ?? 0) !== 0) throw new Error(decoded.message || `errorCode ${decoded.errorCode}`);
    return decoded;
  }

  function captureResourceDomains(decoded) {
    const payload = decoded?.data ?? decoded;
    const values = payload?.resDomains || payload?.resourceDomains || payload?.resourceUrls || [];
    const list = Array.isArray(values) ? values : [values];
    state.resourceBases = unique(list.map(normalizeBase));
  }

  function captureVideos(decoded) {
    const list = decoded?.data?.videoInfo;
    if (!Array.isArray(list)) return;
    state.videoItems = list;
    state.videosById.clear();
    list.forEach((item) => {
      const id = videoId(item);
      if (id) state.videosById.set(id, item);
    });
    scheduleEnhance();
  }

  const previousFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const response = await previousFetch(input, init);
    try {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (/\/sys\/dmCfg(?:$|[?])/i.test(url.pathname + url.search)) {
        captureResourceDomains(await readJsonResponse(response));
      } else if (/\/videos\/short(?:$|[?])/i.test(url.pathname + url.search)) {
        captureVideos(await readJsonResponse(response));
      }
    } catch {
      // 保持原请求行为，不让增强层影响主流程。
    }
    return response;
  };

  function ensurePlayerDetail() {
    let panel = $("#video-detail-panel");
    if (panel) return panel;
    panel = document.createElement("section");
    panel.id = "video-detail-panel";
    panel.className = "video-detail-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="detail-author" role="button" tabindex="0">
        <img class="detail-avatar" alt="作者头像">
        <div class="detail-author-copy">
          <strong class="detail-author-name">—</strong>
          <span class="detail-author-intro">点击查看作者主页</span>
        </div>
      </div>
      <div class="detail-stats" aria-label="视频统计"></div>
      <div class="detail-actions">
        <button type="button" class="ghost-button detail-profile-button">作者主页</button>
        <button type="button" class="detail-download-button">下载视频</button>
      </div>
      <div class="download-progress" hidden>
        <div class="download-progress-bar"><span></span></div>
        <p class="download-progress-text">准备下载…</p>
      </div>`;
    const form = $("#manual-form");
    form?.insertAdjacentElement("afterend", panel);
    $(".detail-profile-button", panel)?.addEventListener("click", () => openAuthorProfile(videoOf(state.currentVideo).user));
    $(".detail-download-button", panel)?.addEventListener("click", () => downloadVideo(state.currentVideo));
    $(".detail-author", panel)?.addEventListener("click", () => openAuthorProfile(videoOf(state.currentVideo).user));
    return panel;
  }

  function statItem(label, value, icon) {
    const item = document.createElement("span");
    item.className = "stat-item";
    item.title = label;
    item.textContent = `${icon} ${formatCount(value)}`;
    return item;
  }

  function showVideoDetail(item) {
    if (!item) return;
    state.currentVideo = item;
    const video = videoOf(item);
    const panel = ensurePlayerDetail();
    panel.hidden = false;
    $(".detail-author-name", panel).textContent = video.user?.username || "未知作者";
    $(".detail-author-intro", panel).textContent = video.user?.introduce || `UID ${video.user?.uid || video.publisherId || "—"}`;
    const avatar = $(".detail-avatar", panel);
    avatar.src = placeholderAvatar();
    setEncryptedImage(avatar, video.user?.avatarURL, 120);
    const stats = $(".detail-stats", panel);
    stats.replaceChildren(
      statItem("播放", video.playCnt, "▶"),
      statItem("点赞", video.likedCnt, "♥"),
      statItem("评论", video.commentCnt, "💬"),
      statItem("收藏", video.collectedCnt, "★")
    );
  }

  function placeholderAvatar() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='100%25' height='100%25' rx='80' fill='%2319233b'/%3E%3Ccircle cx='80' cy='62' r='28' fill='%237d8cff'/%3E%3Cpath d='M28 150c5-36 27-54 52-54s47 18 52 54' fill='%237d8cff'/%3E%3C/svg%3E";
  }

  function cardExtra(item) {
    const video = videoOf(item);
    const extra = document.createElement("div");
    extra.className = "rich-card-extra";

    const author = document.createElement("div");
    author.className = "card-author";
    author.setAttribute("role", "button");
    author.tabIndex = 0;
    const avatar = document.createElement("img");
    avatar.className = "card-avatar";
    avatar.alt = "";
    avatar.src = placeholderAvatar();
    const authorName = document.createElement("span");
    authorName.textContent = video.user?.username || "未知作者";
    author.append(avatar, authorName);
    setEncryptedImage(avatar, video.user?.avatarURL, 120);

    const stats = document.createElement("div");
    stats.className = "card-stats";
    stats.append(
      statItem("播放", video.playCnt, "▶"),
      statItem("点赞", video.likedCnt, "♥"),
      statItem("评论", video.commentCnt, "💬")
    );

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const profile = document.createElement("span");
    profile.className = "card-action";
    profile.textContent = "作者";
    profile.setAttribute("role", "button");
    profile.tabIndex = 0;
    const download = document.createElement("span");
    download.className = "card-action card-download";
    download.textContent = "下载";
    download.setAttribute("role", "button");
    download.tabIndex = 0;
    actions.append(profile, download);
    extra.append(author, stats, actions);

    const openProfile = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAuthorProfile(video.user || { uid: video.publisherId, username: "未知作者" });
    };
    author.addEventListener("click", openProfile);
    profile.addEventListener("click", openProfile);
    download.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      downloadVideo(item);
    });
    return extra;
  }

  function enhanceCards() {
    if (state.enhancing || !state.videoItems.length) return;
    const cards = $$("#video-list .video-card");
    if (!cards.length) return;
    state.enhancing = true;
    try {
      cards.forEach((card, index) => {
        const item = state.videoItems[index];
        if (!item) return;
        const video = videoOf(item);
        const id = videoId(item);
        card.dataset.videoId = id;

        const title = $(".video-meta strong", card);
        if (title) title.textContent = video.name || video.title || title.textContent;
        const duration = $(".video-cover span", card);
        if (duration) duration.textContent = formatDuration(video.time || video.duration);
        const cover = $(".video-cover img", card);
        if (cover) setEncryptedImage(cover, video.verticalCoverURL || video.coverURL, 480);

        if (card.dataset.richVideoId !== id) {
          $(".rich-card-extra", card)?.remove();
          card.append(cardExtra(item));
          card.dataset.richVideoId = id;
        }
        if (!card.dataset.richBound) {
          card.dataset.richBound = "1";
          card.addEventListener("click", () => showVideoDetail(item));
        }
      });
    } finally {
      state.enhancing = false;
    }
  }

  let enhanceTimer = 0;
  function scheduleEnhance() {
    if (enhanceTimer) cancelAnimationFrame(enhanceTimer);
    enhanceTimer = requestAnimationFrame(() => {
      enhanceTimer = 0;
      enhanceCards();
    });
  }

  function createProfileModal() {
    let modal = $("#author-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "author-modal";
    modal.className = "author-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="author-modal-backdrop"></div>
      <section class="author-sheet" role="dialog" aria-modal="true" aria-label="作者主页">
        <button type="button" class="author-close" aria-label="关闭">×</button>
        <header class="author-header">
          <img class="author-avatar" alt="作者头像">
          <div class="author-main">
            <h2 class="author-name">加载中…</h2>
            <p class="author-uid">UID —</p>
            <p class="author-introduce">正在获取作者资料…</p>
          </div>
        </header>
        <div class="author-stats"></div>
        <div class="author-works-heading">
          <h3>短视频作品</h3>
          <span class="author-works-status">加载中…</span>
        </div>
        <div class="author-works"></div>
        <button type="button" class="ghost-button author-more">加载更多</button>
      </section>`;
    document.body.append(modal);
    $(".author-close", modal).addEventListener("click", closeAuthorProfile);
    $(".author-modal-backdrop", modal).addEventListener("click", closeAuthorProfile);
    $(".author-more", modal).addEventListener("click", () => loadAuthorWorks(state.activeAuthor, state.authorPage + 1, true));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) closeAuthorProfile();
    });
    return modal;
  }

  function closeAuthorProfile() {
    const modal = $("#author-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  async function openAuthorProfile(user) {
    const uid = user?.uid ?? user?.id;
    if (!uid) return;
    const modal = createProfileModal();
    modal.hidden = false;
    document.body.classList.add("modal-open");
    state.activeAuthor = { ...user, uid };
    state.authorPage = 1;
    renderAuthorHeader(state.activeAuthor);
    $(".author-works", modal).replaceChildren();
    $(".author-works-status", modal).textContent = "正在加载作品…";
    try {
      const result = await requestApi(`users/${encodeURIComponent(uid)}/info`, { pid: config.pid || "PH" });
      const author = result.data?.user || result.data || state.activeAuthor;
      state.activeAuthor = { ...state.activeAuthor, ...author, uid: author.uid ?? uid };
      renderAuthorHeader(state.activeAuthor);
    } catch (error) {
      $(".author-introduce", modal).textContent = `${state.activeAuthor.introduce || "暂无简介"}（资料接口：${error.message}）`;
    }
    await loadAuthorWorks(state.activeAuthor, 1, false);
  }

  function renderAuthorHeader(author) {
    const modal = createProfileModal();
    $(".author-name", modal).textContent = author?.username || "未知作者";
    $(".author-uid", modal).textContent = `UID ${author?.uid ?? author?.id ?? "—"}`;
    $(".author-introduce", modal).textContent = author?.introduce || "暂无简介";
    const avatar = $(".author-avatar", modal);
    avatar.src = placeholderAvatar();
    setEncryptedImage(avatar, author?.avatarURL, 240);
    const stats = $(".author-stats", modal);
    stats.replaceChildren(
      statItem("作品", author?.videoCnt, "▣"),
      statItem("粉丝", author?.followerCnt, "👤"),
      statItem("获赞", author?.likedCnt, "♥"),
      statItem("收藏", author?.collectCnt, "★")
    );
  }

  async function loadAuthorWorks(author, page = 1, append = false) {
    const modal = createProfileModal();
    const uid = author?.uid ?? author?.id;
    if (!uid) return;
    const status = $(".author-works-status", modal);
    const more = $(".author-more", modal);
    status.textContent = `正在加载第 ${page} 页…`;
    more.disabled = true;
    try {
      const result = await requestApi(`users/${encodeURIComponent(uid)}/videos`, {
        timeType: 3,
        page,
        pageSize: 12,
        pid: config.pid || "PH"
      });
      const works = findArray(result.data);
      if (!append) $(".author-works", modal).replaceChildren();
      works.forEach((item) => renderAuthorWork(item, $(".author-works", modal)));
      state.authorPage = page;
      status.textContent = works.length ? `第 ${page} 页 · ${works.length} 条` : "没有更多作品";
      more.hidden = works.length < 12;
    } catch (error) {
      status.textContent = `作品加载失败：${error.message}`;
    } finally {
      more.disabled = false;
    }
  }

  function renderAuthorWork(item, container) {
    const video = videoOf(item);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "author-work-card";
    const cover = document.createElement("img");
    cover.alt = "";
    cover.src = placeholderAvatar();
    setEncryptedImage(cover, video.verticalCoverURL || video.coverURL, 480);
    const info = document.createElement("div");
    info.innerHTML = `<strong></strong><span></span>`;
    $("strong", info).textContent = video.name || video.title || "未命名视频";
    $("span", info).textContent = `▶ ${formatCount(video.playCnt)}　♥ ${formatCount(video.likedCnt)}　${formatDuration(video.time)}`;
    card.append(cover, info);
    card.addEventListener("click", async () => {
      card.disabled = true;
      try {
        const playable = await getPlayableItem(item);
        closeAuthorProfile();
        playThroughMain(playable);
      } catch (error) {
        alert(`无法加载该作品：${error.message}`);
      } finally {
        card.disabled = false;
      }
    });
    container.append(card);
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
        const result = await requestApi(path, { pid: config.pid || "PH" });
        const payload = result.data || {};
        const candidate = payload.video || payload;
        const url = payload.url || candidate.url || candidate.playURL || candidate.playUrl;
        if (url) return { video: { ...video, ...candidate }, url };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("服务器没有返回播放地址");
  }

  function playThroughMain(item) {
    const id = videoId(item);
    const mainCard = id ? $(`#video-list .video-card[data-video-id="${CSS.escape(id)}"]`) : null;
    if (mainCard) {
      mainCard.click();
      mainCard.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const url = item.url || videoOf(item).url;
    if (!url) return;
    const input = $("#manual-url");
    if (input) input.value = url;
    $("#manual-form")?.requestSubmit();
    showVideoDetail(item);
  }

  function setDownloadProgress(text, percent = 0, visible = true) {
    const panel = ensurePlayerDetail();
    const wrap = $(".download-progress", panel);
    const bar = $(".download-progress-bar span", panel);
    const label = $(".download-progress-text", panel);
    wrap.hidden = !visible;
    label.textContent = text;
    const safe = Math.max(0, Math.min(100, Number(percent || 0)));
    bar.style.width = `${safe}%`;
    bar.classList.toggle("indeterminate", visible && safe <= 0);
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function withPlaybackParams(value) {
    try {
      const url = new URL(value);
      if (config.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", config.pid);
      const resource = currentResource();
      if (resource && !url.searchParams.has("domain")) url.searchParams.set("domain", resource);
      return url.href;
    } catch {
      return value;
    }
  }

  async function tryDirectMp4(item) {
    const video = videoOf(item);
    const path = video.mp4PlayURL || video.mp4PlayUrl || "";
    if (!path) return false;
    const candidates = /^https?:\/\//i.test(path)
      ? [path]
      : [currentResource(), currentApi()].filter(Boolean).map((base) => joinUrl(base, path));
    for (const url of candidates) {
      try {
        setDownloadProgress("正在尝试 MP4 文件…", 0, true);
        const response = await binaryFetch(url, { cache: "no-store", credentials: "omit" });
        if (!response.ok) continue;
        const type = response.headers.get("content-type") || "";
        if (/text\/html|application\/json/i.test(type)) continue;
        const blob = await response.blob();
        if (!blob.size) continue;
        triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.mp4`);
        setDownloadProgress(`MP4 下载已开始 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 100, true);
        return true;
      } catch {
        // 尝试下一条地址。
      }
    }
    return false;
  }

  async function fetchPlaylistText(url) {
    const response = await binaryFetch(withPlaybackParams(url), {
      headers: { m: "1" },
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) throw new Error(`m3u8 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      const text = pako.inflate(bytes, { to: "string" });
      if (text.includes("#EXTM3U")) return text;
    } catch {
      // 普通文本播放列表。
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("服务器没有返回有效 m3u8");
    return text;
  }

  function parseAttributeList(value) {
    const result = {};
    String(value || "").replace(/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi, (_all, key, raw) => {
      result[key.toUpperCase()] = String(raw || "").replace(/^"|"$/g, "");
      return _all;
    });
    return result;
  }

  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = parseAttributeList(lines[i].slice(lines[i].indexOf(":") + 1));
      let next = i + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].startsWith("#"))) next += 1;
      if (next < lines.length) {
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          url: new URL(lines[next].trim(), baseUrl).href
        });
      }
    }
    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  async function resolveMediaPlaylist(url) {
    let current = withPlaybackParams(url);
    for (let depth = 0; depth < 3; depth += 1) {
      const text = await fetchPlaylistText(current);
      const variants = parseMasterPlaylist(text, current);
      if (!variants.length) return { url: current, text };
      current = variants[0].url;
    }
    throw new Error("HLS 主播放列表嵌套过深");
  }

  function parseIv(value, sequence) {
    if (value && /^0x[0-9a-f]+$/i.test(value)) {
      const hex = value.slice(2).padStart(32, "0").slice(-32);
      return Uint8Array.from(hex.match(/.{2}/g).map((part) => parseInt(part, 16)));
    }
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sequence >>> 0);
    return iv;
  }

  function parseMediaPlaylist(text, sourceUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let sequence = 0;
    let key = null;
    let initUrl = "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        sequence = Number(line.split(":")[1] || 0);
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
        key = { method: attrs.METHOD || "NONE", iv: attrs.IV || "" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
        if (attrs.URI) initUrl = new URL(attrs.URI, sourceUrl).href;
      } else if (!line.startsWith("#")) {
        segments.push({
          url: new URL(line, sourceUrl).href,
          sequence,
          key: { ...key }
        });
        sequence += 1;
      }
    }
    return { segments, initUrl };
  }

  async function decryptSegment(bytes, keyInfo, sequence) {
    if (!keyInfo || keyInfo.method === "NONE") return bytes;
    if (String(keyInfo.method).toUpperCase() !== "AES-128") throw new Error(`暂不支持 ${keyInfo.method} 加密`);
    const rawKey = base64ToBytes(config.mediaKeyBase64);
    const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const iv = parseIv(keyInfo.iv, sequence);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, bytes);
    return new Uint8Array(decrypted);
  }

  async function downloadHls(item) {
    const video = videoOf(item);
    const signedUrl = withPlaybackParams(item.url || video.url || "");
    if (!signedUrl) throw new Error("没有 HLS 播放地址");
    setDownloadProgress("正在读取 HLS 播放列表…", 2, true);
    const playlist = await resolveMediaPlaylist(signedUrl);
    const parsed = parseMediaPlaylist(playlist.text, playlist.url);
    if (!parsed.segments.length) throw new Error("播放列表中没有视频分片");
    const chunks = [];
    if (parsed.initUrl) {
      const initResponse = await binaryFetch(parsed.initUrl, { cache: "no-store", credentials: "omit" });
      if (!initResponse.ok) throw new Error(`初始化分片 HTTP ${initResponse.status}`);
      chunks.push(new Uint8Array(await initResponse.arrayBuffer()));
    }
    for (let i = 0; i < parsed.segments.length; i += 1) {
      const segment = parsed.segments[i];
      setDownloadProgress(`正在下载分片 ${i + 1}/${parsed.segments.length}`, 5 + ((i + 1) / parsed.segments.length) * 90, true);
      const response = await binaryFetch(segment.url, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`分片 ${i + 1} HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(await decryptSegment(bytes, segment.key, segment.sequence));
    }
    const extension = parsed.initUrl ? "mp4" : "ts";
    const mime = parsed.initUrl ? "video/mp4" : "video/mp2t";
    const blob = new Blob(chunks, { type: mime });
    triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.${extension}`);
    setDownloadProgress(`HLS 下载已开始 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 100, true);
  }

  async function downloadVideo(item) {
    if (!item) return;
    const button = $(".detail-download-button", ensurePlayerDetail());
    button.disabled = true;
    try {
      try {
        if (await tryDirectMp4(item)) return;
      } catch (error) {
        setDownloadProgress(`MP4 不可用，改用 HLS：${error.message}`, 3, true);
      }
      await downloadHls(item);
    } catch (error) {
      setDownloadProgress(`下载失败：${error.message}`, 0, true);
    } finally {
      button.disabled = false;
    }
  }

  function observeList() {
    const list = $("#video-list");
    if (!list) return;
    const observer = new MutationObserver((mutations) => {
      const hasNewCards = mutations.some((mutation) =>
        [...mutation.addedNodes].some((node) =>
          node.nodeType === 1 && (node.matches?.(".video-card") || node.querySelector?.(".video-card"))
        )
      );
      if (hasNewCards) scheduleEnhance();
    });
    // 只观察列表直接子节点；增强层在卡片内部追加信息不会再次触发自己。
    observer.observe(list, { childList: true, subtree: false });
  }

  function boot() {
    ensurePlayerDetail();
    createProfileModal();
    observeList();
    scheduleEnhance();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
