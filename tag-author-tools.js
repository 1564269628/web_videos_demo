(() => {
  "use strict";

  const VERSION = "20260802-31";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";

  const state = {
    items: [],
    authorCache: new Map(),
    authorPromises: new Map(),
    archivePromises: new Map(),
    observer: null,
    timer: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function log(message, details, level = "log") {
    console[level](`[TAG AUTHOR TOOLS ${VERSION}] ${message}`, details ?? "");
    const output = $("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeJson(details)}`;
    output.textContent = `[${time}] [标签作者] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function clean(value, fallback = "未命名", max = 80) {
    return (String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback).slice(0, max);
  }

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || "").trim());
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function currentApi() {
    return normalizeBase($("#active-api")?.textContent);
  }

  function token() {
    return localStorage.getItem(cfg.storageKeys?.token || "hq-video-token") || "";
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function decryptEnvelope(body) {
    if (!body || typeof body.data !== "string" || !body.data) return body;
    const decrypted = CryptoJS.AES.decrypt(
      body.data,
      CryptoJS.enc.Utf8.parse(cfg.aesKey),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    const compressed = CryptoJS.enc.Utf8.stringify(decrypted);
    if (!compressed) throw new Error("API 解密结果为空");
    return { ...body, data: JSON.parse(pako.inflate(base64ToBytes(compressed), { to: "string" })) };
  }

  async function apiGet(path, params = {}) {
    const api = currentApi();
    if (!api) throw new Error("网页 API 尚未连接");
    const url = new URL(String(path || "").replace(/^\/+/, ""), api);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const response = await fetch(url.href, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        t: "2",
        k: "2",
        token: token(),
        version: String(cfg.webVersion || "1.2.75")
      }
    });
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);
    const decoded = decryptEnvelope(JSON.parse(await response.text()));
    if (Number(decoded.errorCode || 0) !== 0) throw new Error(decoded.message || `errorCode ${decoded.errorCode}`);
    return decoded;
  }

  function findArray(value, depth = 0) {
    if (depth > 8 || value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];
    for (const key of ["videoInfo", "contents", "videos", "list", "items", "records", "rows", "data"]) {
      const found = findArray(value[key], depth + 1);
      if (found.length) return found;
    }
    return [];
  }

  function videoOf(value) {
    return value?.video && typeof value.video === "object" ? value.video : value || {};
  }

  function videoId(value) {
    const video = videoOf(value);
    return String(video.id ?? video.videoId ?? video.vid ?? value?.id ?? "");
  }

  function publisherId(value) {
    const video = videoOf(value);
    return String(video.publisherId ?? video.publisherUID ?? video.publisherUid ?? video.user?.uid ?? value?.publisherId ?? "").trim();
  }

  function parseCatalogItems() {
    const element = $("#catalog-json");
    if (!element) return [];
    try {
      const parsed = JSON.parse(element.textContent || "{}");
      const payload = parsed?.decoded?.data ?? parsed?.decoded ?? parsed?.data ?? parsed;
      const items = findArray(payload);
      return items.filter((item) => publisherId(item));
    } catch {
      return [];
    }
  }

  function authorFallback(uid) {
    return { uid, username: `UID ${uid}` };
  }

  async function getAuthorInfo(uid, fallback = {}) {
    const key = String(uid || "").trim();
    if (!key) return authorFallback("");
    if (state.authorCache.has(key)) return state.authorCache.get(key);
    if (state.authorPromises.has(key)) return state.authorPromises.get(key);

    const promise = (async () => {
      try {
        const path = String(cfg.authorInfoPath || "users/{uid}/info").replace("{uid}", encodeURIComponent(key));
        const response = await apiGet(path, { pid: cfg.pid || "PH" });
        const author = response.data?.user || response.data || fallback || {};
        const value = { ...fallback, ...author, uid: author.uid ?? key, __raw: response };
        state.authorCache.set(key, value);
        return value;
      } catch (error) {
        const value = { ...fallback, ...authorFallback(key), __error: error.message || String(error) };
        state.authorCache.set(key, value);
        return value;
      } finally {
        state.authorPromises.delete(key);
      }
    })();

    state.authorPromises.set(key, promise);
    return promise;
  }

  function normalizeWork(value, index = 0) {
    const work = videoOf(value);
    const tags = Array.isArray(work.videoTags)
      ? work.videoTags
      : Array.isArray(work.tags)
        ? work.tags.map((tag) => typeof tag === "string" ? tag : tag?.name).filter(Boolean)
        : [];
    return {
      index: Number(value?.index || work.index || index + 1),
      id: videoId(value),
      title: work.title || work.name || "",
      description: work.description || work.introduce || "",
      tags,
      durationSeconds: Number(work.durationSeconds || work.time || 0),
      width: Number(work.width || 0),
      height: Number(work.height || 0),
      playCount: Number(work.playCount ?? work.playCnt ?? 0),
      likeCount: Number(work.likeCount ?? work.likedCnt ?? 0),
      commentCount: Number(work.commentCount ?? work.commentCnt ?? 0),
      collectCount: Number(work.collectCount ?? work.collectedCnt ?? 0),
      releaseDate: work.releaseDate || "",
      releaseDateLabel: work.releaseDateLabel || "",
      categories: work.categories || [],
      coverPath: work.coverPath || work.verticalCoverURL || work.coverURL || "",
      playPath: work.playPath || work.playURL || work.playUrl || "",
      signedPlaylistUrl: value?.url || work.url || work.signedPlaylistUrl || ""
    };
  }

  function csv(rows) {
    const keys = ["index", "id", "title", "description", "tags", "durationSeconds", "width", "height", "playCount", "likeCount", "commentCount", "collectCount", "releaseDate", "releaseDateLabel", "coverPath", "playPath", "signedPlaylistUrl"];
    const quote = (value) => `"${(Array.isArray(value) ? value.join("|") : String(value ?? "")).replace(/"/g, '""')}"`;
    return `\ufeff${keys.join(",")}\n${rows.map((row) => keys.map((key) => quote(row[key])).join(",")).join("\n")}\n`;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbSet(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function hasPermission(handle, request = false) {
    if (!handle) return false;
    const options = { mode: "readwrite" };
    try {
      if ((await handle.queryPermission(options)) === "granted") return true;
      if (request && (await handle.requestPermission(options)) === "granted") return true;
    } catch {
      return false;
    }
    return false;
  }

  async function getArchiveRoot(request = false) {
    const stored = await idbGet(ROOT_KEY).catch(() => null);
    if (stored && await hasPermission(stored, request)) return stored;
    if (!request) return null;
    if (typeof showDirectoryPicker !== "function") throw new Error("请使用最新版 Edge 或 Chrome 选择归档总目录");
    const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-all-authors-root" });
    if (!(await hasPermission(handle, true))) throw new Error("没有所选目录的读写权限");
    await idbSet(ROOT_KEY, handle);
    return handle;
  }

  async function writeFile(directory, name, data) {
    const handle = await directory.getFileHandle(clean(name, "file", 160), { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(data); }
    finally { await writable.close(); }
  }

  async function writeJson(directory, name, value) {
    await writeFile(directory, name, JSON.stringify(value, null, 2));
  }

  async function readJson(directory, name, fallback = null) {
    try {
      const handle = await directory.getFileHandle(name);
      return JSON.parse(await (await handle.getFile()).text());
    } catch {
      return fallback;
    }
  }

  async function fetchAllAuthorWorks(uid, onProgress) {
    const path = String(cfg.authorVideosPath || "users/{uid}/videos").replace("{uid}", encodeURIComponent(uid));
    const output = [];
    const seen = new Set();
    for (let page = 1; page <= 10000; page += 1) {
      const response = await apiGet(path, { timeType: 3, page, pageSize: 20, pid: cfg.pid || "PH" });
      const items = findArray(response.data);
      let added = 0;
      for (const item of items) {
        const id = videoId(item) || `${page}-${output.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        output.push(item);
        added += 1;
      }
      onProgress?.(page, output.length);
      if (!items.length || !added || items.length < 20) break;
    }
    return output;
  }

  async function archiveAuthor(uid, seed = {}, button = null) {
    const key = String(uid || "").trim();
    if (!key) throw new Error("作者 UID 为空");
    if (state.archivePromises.has(key)) return state.archivePromises.get(key);

    const promise = (async () => {
      const oldText = button?.textContent;
      if (button) { button.disabled = true; button.textContent = "正在读取作者…"; }
      const root = await getArchiveRoot(true);
      const author = await getAuthorInfo(key, seed);
      const username = author.username || seed.username || `UID${key}`;
      const folderName = `${clean(username, `UID${key}`, 60)}_UID${key}`;
      const authorDir = await root.getDirectoryHandle(folderName, { create: true });

      if (button) button.textContent = "正在读取全部作品…";
      const rawWorks = await fetchAllAuthorWorks(key, (page, count) => {
        if (button) button.textContent = `作品第${page}页 · ${count}条`;
      });
      const works = rawWorks.map(normalizeWork);

      await writeJson(authorDir, "author.raw.json", author.__raw || author);
      await writeJson(authorDir, "author.json", {
        id: author.id || "",
        uid: author.uid ?? key,
        username,
        signature: author.introduce || author.signature || "",
        videoCount: author.videoCnt ?? works.length,
        followerCount: author.followerCnt ?? null,
        likedCount: author.likedCnt ?? null,
        collectCount: author.collectCnt ?? null,
        avatarPath: author.avatarURL || "",
        backgroundPath: author.bgCoverUrl || "",
        scannedFromTagAt: new Date().toISOString()
      });
      await writeJson(authorDir, "works.raw.json", rawWorks);
      await writeJson(authorDir, "works.json", works);
      await writeFile(authorDir, "works.csv", csv(works));
      await authorDir.getDirectoryHandle("works", { create: true });

      const exportState = await readJson(authorDir, "export-state.json", { completed: [], failed: {} }) || { completed: [], failed: {} };
      exportState.updatedAt = new Date().toISOString();
      exportState.uid = key;
      exportState.author = username;
      await writeJson(authorDir, "export-state.json", exportState);

      log("作者全部作品元数据已保存", {
        username,
        uid: key,
        works: works.length,
        folder: folderName,
        workCoversSaved: 0
      });
      return { uid: key, username, works: works.length, folderName, rootName: root.name };
    })().finally(() => {
      state.archivePromises.delete(key);
      if (button) button.disabled = false;
    });

    state.archivePromises.set(key, promise);
    try {
      const result = await promise;
      if (button) button.textContent = `已归档 ${result.works} 条`;
      setTimeout(() => { if (button?.isConnected) button.textContent = button.dataset.defaultText || "归档作者"; }, 3000);
      return result;
    } catch (error) {
      if (button) {
        button.textContent = "归档失败";
        setTimeout(() => { if (button?.isConnected) button.textContent = button.dataset.defaultText || "归档作者"; }, 3000);
      }
      throw error;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function parsePageLabel() {
    const text = $("#aad-page-label")?.textContent || "";
    const match = text.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
    return match ? { page: Number(match[1]), pages: Number(match[2]) } : { page: 1, pages: 1 };
  }

  async function queueAuthorDownloads(folderName, button) {
    if (!window.ALL_AUTHORS_ARCHIVE) throw new Error("全部作者归档中心尚未加载");
    if (button) { button.disabled = true; button.textContent = "正在扫描归档…"; }
    await window.ALL_AUTHORS_ARCHIVE.scan();
    window.ALL_AUTHORS_ARCHIVE.open();
    await sleep(120);

    const panel = $("#all-authors-center");
    const search = $("#aad-search", panel);
    if (!panel || !search) throw new Error("全部作者归档中心界面尚未就绪");
    search.value = folderName;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);

    const previous = $("#aad-prev", panel);
    for (let guard = 0; guard < 200 && parsePageLabel().page > 1; guard += 1) {
      previous?.click();
      await sleep(50);
    }

    let queued = 0;
    for (let guard = 0; guard < 20000; guard += 1) {
      const eligible = $$("[data-aad-enqueue]:not(:disabled)", panel);
      if (eligible.length) {
        eligible[0].click();
        queued += 1;
        if (button) button.textContent = `已加入 ${queued} 条…`;
        await sleep(40);
        continue;
      }

      const page = parsePageLabel();
      if (page.page >= page.pages) break;
      $("#aad-next", panel)?.click();
      await sleep(80);
    }

    log("指定作者作品已加入下载队列", { folderName, queued });
    return queued;
  }

  async function downloadAuthor(uid, seed, button) {
    const old = button?.dataset.defaultText || "下载该作者全部视频";
    try {
      if (button) { button.disabled = true; button.textContent = "正在归档作者…"; }
      const result = await archiveAuthor(uid, seed, null);
      const queued = await queueAuthorDownloads(result.folderName, button);
      if (button) button.textContent = queued ? `已加入 ${queued} 条` : "没有待下载作品";
      setTimeout(() => { if (button?.isConnected) { button.disabled = false; button.textContent = old; } }, 3500);
    } catch (error) {
      log("下载指定作者全部视频失败", { uid, error: error.message || String(error) }, "error");
      if (button) {
        button.disabled = false;
        button.textContent = "操作失败";
        setTimeout(() => { if (button?.isConnected) button.textContent = old; }, 3000);
      }
      alert(error.message || error);
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(String(text)); }
    catch {
      const area = document.createElement("textarea");
      area.value = String(text);
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function ensureModal() {
    let modal = $("#tag-author-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "tag-author-modal";
    modal.className = "tag-author-modal";
    modal.hidden = true;
    modal.innerHTML = `<div class="tag-author-dialog">
      <button type="button" class="tag-author-close" aria-label="关闭">×</button>
      <div id="tag-author-modal-body"></div>
    </div>`;
    document.body.append(modal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest(".tag-author-close")) modal.hidden = true;
    });
    return modal;
  }

  async function showAuthor(uid, seed) {
    const modal = ensureModal();
    const body = $("#tag-author-modal-body", modal);
    modal.hidden = false;
    body.innerHTML = `<p class="tag-author-loading">正在获取作者 ${clean(uid, "UID")}…</p>`;
    const author = await getAuthorInfo(uid, seed);
    const username = author.username || `UID ${uid}`;
    body.innerHTML = `<p class="tag-author-eyebrow">AUTHOR PROFILE</p>
      <h2>${escapeHtml(username)}</h2>
      <dl class="tag-author-profile">
        <div><dt>作者 UID</dt><dd>${escapeHtml(uid)}</dd></div>
        <div><dt>作品数</dt><dd>${escapeHtml(author.videoCnt ?? "—")}</dd></div>
        <div><dt>粉丝数</dt><dd>${escapeHtml(author.followerCnt ?? "—")}</dd></div>
        <div><dt>获赞数</dt><dd>${escapeHtml(author.likedCnt ?? "—")}</dd></div>
      </dl>
      <p>${escapeHtml(author.introduce || author.signature || "没有作者简介")}</p>
      <div class="tag-author-modal-actions">
        <button type="button" data-modal-copy>复制作者 ID</button>
        <button type="button" data-modal-archive>归档作者</button>
        <button type="button" data-modal-download>下载该作者全部视频</button>
      </div>`;
    $("[data-modal-copy]", body).onclick = async (event) => {
      await copyText(uid);
      event.currentTarget.textContent = "已复制";
    };
    const archive = $("[data-modal-archive]", body);
    archive.dataset.defaultText = "归档作者";
    archive.onclick = () => archiveAuthor(uid, author, archive).catch((error) => alert(error.message || error));
    const download = $("[data-modal-download]", body);
    download.dataset.defaultText = "下载该作者全部视频";
    download.onclick = () => downloadAuthor(uid, author, download);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function seedForItem(item) {
    const video = videoOf(item);
    return video.user || item.user || { uid: publisherId(item) };
  }

  function decorateCard(card, item, index) {
    const uid = publisherId(item);
    if (!uid) return;
    const id = videoId(item);
    card.dataset.publisherId = uid;
    card.dataset.videoId = id;

    let wrapper = card.closest(".tag-author-card-wrap");
    if (!wrapper) {
      wrapper = document.createElement("article");
      wrapper.className = "tag-author-card-wrap";
      card.parentNode.insertBefore(wrapper, card);
      wrapper.append(card);
    }
    wrapper.dataset.publisherId = uid;
    wrapper.dataset.videoId = id;
    wrapper.dataset.cardIndex = String(index);

    const meta = $(".video-meta", card);
    let authorLine = $(".tag-author-line", meta || card);
    if (!authorLine) {
      authorLine = document.createElement("small");
      authorLine.className = "tag-author-line";
      (meta || card).append(authorLine);
    }
    authorLine.textContent = `作者：加载中 · UID ${uid}`;

    let idLine = $(".tag-video-id-line", meta || card);
    if (!idLine) {
      idLine = document.createElement("small");
      idLine.className = "tag-video-id-line";
      (meta || card).append(idLine);
    }
    idLine.textContent = `视频 ID：${id || "—"}`;

    let actions = $(".tag-author-actions", wrapper);
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "tag-author-actions";
      actions.innerHTML = `<button type="button" data-author-view>查看作者</button>
        <button type="button" data-author-copy class="ghost-button">复制作者 ID</button>
        <button type="button" data-author-archive class="ghost-button">归档作者</button>
        <button type="button" data-author-download>下载全部视频</button>`;
      wrapper.append(actions);
    }

    const seed = seedForItem(item);
    $("[data-author-view]", actions).onclick = () => showAuthor(uid, seed);
    $("[data-author-copy]", actions).onclick = async (event) => {
      await copyText(uid);
      const button = event.currentTarget;
      button.textContent = "已复制";
      setTimeout(() => { if (button.isConnected) button.textContent = "复制作者 ID"; }, 1500);
    };
    const archive = $("[data-author-archive]", actions);
    archive.dataset.defaultText = "归档作者";
    archive.onclick = () => archiveAuthor(uid, seed, archive).catch((error) => alert(error.message || error));
    const download = $("[data-author-download]", actions);
    download.dataset.defaultText = "下载全部视频";
    download.onclick = () => downloadAuthor(uid, seed, download);

    getAuthorInfo(uid, seed).then((author) => {
      if (!authorLine.isConnected || card.dataset.publisherId !== uid) return;
      authorLine.textContent = `作者：${author.username || `UID ${uid}`} · UID ${uid}`;
    });
  }

  function refreshItems() {
    const items = parseCatalogItems();
    if (items.length) state.items = items;
  }

  function decorate() {
    refreshItems();
    const list = $("#video-list");
    if (!list || !state.items.length) return;
    const cards = $$(".video-card", list);
    if (!cards.length) return;
    cards.forEach((card, index) => {
      const item = state.items[index];
      if (item) decorateCard(card, item, index);
    });
  }

  function scheduleDecorate() {
    clearTimeout(state.timer);
    state.timer = setTimeout(decorate, 40);
  }

  function injectStyles() {
    if ($("#tag-author-tools-styles")) return;
    const style = document.createElement("style");
    style.id = "tag-author-tools-styles";
    style.textContent = `
      .tag-author-card-wrap{min-width:0;display:flex;flex-direction:column;border:1px solid rgba(125,140,255,.2);border-radius:14px;overflow:hidden;background:rgba(12,18,34,.82)}
      .tag-author-card-wrap>.video-card{width:100%;border:0!important;border-radius:0!important;flex:1}
      .tag-author-line{display:block;margin-top:5px;color:#75dfc7!important;font-weight:700;overflow-wrap:anywhere}
      .tag-video-id-line{display:block;margin-top:3px;color:#8f9ab8!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
      .tag-author-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-top:1px solid rgba(125,140,255,.16)}
      .tag-author-actions button{min-width:0;padding:7px 6px;font-size:11px;white-space:normal}
      .tag-author-modal{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:20px;background:rgba(2,5,13,.82);backdrop-filter:blur(8px)}
      .tag-author-modal[hidden]{display:none}
      .tag-author-dialog{position:relative;width:min(620px,100%);max-height:88vh;overflow:auto;padding:24px;border:1px solid rgba(125,140,255,.3);border-radius:18px;background:#10172a;box-shadow:0 24px 80px rgba(0,0,0,.5)}
      .tag-author-close{position:absolute;right:12px;top:10px;width:36px;height:36px;padding:0;border-radius:50%;font-size:24px}
      .tag-author-eyebrow{margin:0 0 6px;color:#75dfc7;font-size:11px;letter-spacing:.12em}
      .tag-author-profile{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}
      .tag-author-profile div{padding:10px;border-radius:10px;background:rgba(255,255,255,.05)}
      .tag-author-profile dt{font-size:11px;color:#96a0ba}.tag-author-profile dd{margin:4px 0 0;font-weight:700;overflow-wrap:anywhere}
      .tag-author-modal-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}
      @media(max-width:720px){.tag-author-modal-actions{grid-template-columns:1fr}.tag-author-profile{grid-template-columns:1fr}.tag-author-actions{grid-template-columns:1fr}}
    `;
    document.head.append(style);
  }

  function boot() {
    injectStyles();
    ensureModal();
    state.observer = new MutationObserver(scheduleDecorate);
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scheduleDecorate();
    window.TAG_AUTHOR_TOOLS = {
      version: VERSION,
      refresh: decorate,
      getAuthorInfo,
      archiveAuthor,
      downloadAuthor,
      get items() { return state.items.slice(); }
    };
    log("标签作者显示与指定作者归档工具已加载；作品封面只在实际下载时保存");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
