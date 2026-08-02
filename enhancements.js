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

  function resolveAsset(path, size = 0) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    if (/^data:image\//i.test(raw) || /^blob:/i.test(raw)) return raw;
    try {
      if (/^https?:\/\//i.test(raw)) return raw;
      const base = currentResource() || currentApi();
      if (!base) return "";
      let resolved = joinUrl(base, raw);
      if (size && /\.(ceb|geb)(?:$|[?#])/i.test(resolved) && !resolved.includes("@")) {
        resolved += `@webp-${size}`;
      }
      return resolved;
    } catch {
      return "";
    }
  }

  async function decryptCeb(url) {
    if (!url) return "";
    if (state.imageCache.has(url)) return state.imageCache.get(url);
    const promise = (async () => {
      const response = await binaryFetch(url, { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error(`图片 HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (contentType.startsWith("image/")) {
        return URL.createObjectURL(new Blob([bytes], { type: contentType }));
      }
      const key = CryptoJS.enc.Utf8.parse(config.imageAesKey || "82758dd12749c777ef579f1839ceea6a");
      const decrypted = CryptoJS.AES.decrypt(bytesToBase64(bytes), key, {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
        blockSize: 16
      });
      const result = CryptoJS.enc.Utf8.stringify(decrypted);
      if (!result) throw new Error("图片 AES 解密为空");
      if (/^data:image\//i.test(result)) return result;
      if (/^[A-Za-z0-9+/=\s]+$/.test(result)) return `data:image/webp;base64,${result.replace(/\s+/g, "")}`;
      throw new Error("图片解密结果格式未知");
    })().catch(async (error) => {
      if (/@webp-\d+(?:$|[?#])/.test(url)) {
        const fallback = url.replace(/@webp-\d+(?=$|[?#])/, "");
        if (fallback !== url) return decryptCeb(fallback);
      }
      throw error;
    });
    state.imageCache.set(url, promise);
    return promise;
  }

  async function setEncryptedImage(img, path, size = 0) {
    if (!img || !path) return;
    const resolved = resolveAsset(path, size);
    if (!resolved) return;
    try {
      img.src = /\.(ceb|geb)(?:@[^/?#]+)?(?:$|[?#])/i.test(resolved)
        ? await decryptCeb(resolved)
        : resolved;
    } catch (error) {
      img.dataset.imageError = error.message;
    }
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
      if (/\/videos\/short(?:$|[?])/i.test(url.pathname + url.search)) {
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
    cards.forEach((card, index) => {
      const item = state.videoItems[index];
      if (!item) return;
      const video = videoOf(item);
      card.dataset.videoId = videoId(item);
      const title = $(".video-meta strong", card);
      if (title) title.textContent = video.name || video.title || title.textContent;
      const duration = $(".video-cover span", card);
      if (duration) duration.textContent = formatDuration(video.time || video.duration);
      const cover = $(".video-cover img", card);
      if (cover) setEncryptedImage(cover, video.verticalCoverURL || video.coverURL, 480);
      if (!$(".rich-card-extra", card)) card.append(cardExtra(item));
      if (!card.dataset.richBound) {
        card.dataset.richBound = "1";
        card.addEventListener("click", () => showVideoDetail(item));
      }
    });
    state.enhancing = false;
  }

  let enhanceTimer = 0;
  function scheduleEnhance() {
    clearTimeout(enhanceTimer);
    enhanceTimer = window.setTimeout(enhanceCards, 100);
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
    const result = await requestApi(`videos/${encodeURIComponent(id)}`, {
      openCancel: true,
      pid: config.pid || "PH"
    });
    const data = result.data || {};
    if (!data.url) throw new Error("视频详情接口没有返回播放地址");
    return { ...data, video: data.video || video };
  }

  function withPlaybackParams(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.has("pid")) parsed.searchParams.set("pid", config.pid || "PH");
      if (!parsed.searchParams.has("domain") && currentResource()) parsed.searchParams.set("domain", currentResource());
      return parsed.href;
    } catch {
      return url;
    }
  }

  function playThroughMain(item) {
    const video = videoOf(item);
    const url = withPlaybackParams(item.url || video.url || "");
    if (!url) throw new Error("没有播放地址");
    const input = $("#manual-url");
    const form = $("#manual-form");
    input.value = url;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    window.setTimeout(() => {
      const title = $("#now-title");
      if (title) title.textContent = video.name || video.title || "视频播放";
      showVideoDetail({ ...item, video });
      $("#video")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }

  function setDownloadProgress(text, percent = null, active = true) {
    const panel = ensurePlayerDetail();
    const wrap = $(".download-progress", panel);
    const label = $(".download-progress-text", panel);
    const bar = $(".download-progress-bar span", panel);
    wrap.hidden = !active;
    label.textContent = text;
    if (percent == null) {
      bar.style.width = "18%";
      bar.classList.add("indeterminate");
    } else {
      bar.classList.remove("indeterminate");
      bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function tryDirectMp4(item) {
    const video = videoOf(item);
    const path = video.mp4PlayURL;
    if (!path) return false;
    const url = resolveAsset(path, 0);
    if (!url) return false;
    setDownloadProgress("正在尝试下载 MP4…", null, true);
    const response = await binaryFetch(url, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`MP4 HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("MP4 文件为空");
    triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.mp4`);
    setDownloadProgress(`MP4 下载已开始 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 100, true);
    return true;
  }

  function parseAttributeList(text) {
    const result = {};
    const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let match;
    while ((match = regex.exec(text))) result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
    return result;
  }

  function parseIv(value, sequence) {
    if (value) {
      const hex = value.replace(/^0x/i, "").padStart(32, "0").slice(-32);
      return Uint8Array.from(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
    }
    const iv = new Uint8Array(16);
    let n = BigInt(sequence);
    for (let i = 15; i >= 0; i -= 1) {
      iv[i] = Number(n & 255n);
      n >>= 8n;
    }
    return iv;
  }

  async function fetchPlaylist(url) {
    const response = await binaryFetch(url, { headers: { m: "1" }, cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`m3u8 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text;
    try {
      text = pako.inflate(bytes, { to: "string" });
    } catch {
      text = new TextDecoder().decode(bytes);
    }
    if (!text.includes("#EXTM3U")) throw new Error("服务器返回的不是 HLS 播放列表");
    return text;
  }

  async function resolveMediaPlaylist(url, depth = 0) {
    const text = await fetchPlaylist(url);
    if (!text.includes("#EXT-X-STREAM-INF") || depth >= 2) return { url, text };
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const attrs = parseAttributeList(lines[i].split(":").slice(1).join(":"));
      let next = i + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].startsWith("#"))) next += 1;
      if (next < lines.length) variants.push({ url: new URL(lines[next].trim(), url).href, bandwidth: Number(attrs.BANDWIDTH || 0) });
    }
    if (!variants.length) return { url, text };
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return resolveMediaPlaylist(variants[0].url, depth + 1);
  }

  function parseMediaPlaylist(text, sourceUrl) {
    const lines = text.split(/\r?\n/);
    let sequence = 0;
    let key = { method: "NONE", iv: "" };
    let initUrl = "";
    const segments = [];
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
    const observer = new MutationObserver(scheduleEnhance);
    observer.observe(list, { childList: true, subtree: true });
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
