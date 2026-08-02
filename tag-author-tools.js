(() => {
  "use strict";

  const VERSION = "20260802-32";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const activeTagId = String(new URL(location.href).searchParams.get("tagId") || "").trim();
  if (!activeTagId) return;

  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const state = {
    items: [],
    authors: new Map(),
    authorRequests: new Map(),
    archiveRequests: new Map(),
    timer: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(message, details, level = "log") {
    console[level](`[TAG AUTHOR TOOLS ${VERSION}] ${message}`, details ?? "");
    const output = $("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    output.textContent = `[${time}] [标签作者] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function setText(element, value) {
    const text = String(value ?? "");
    if (element && element.textContent !== text) element.textContent = text;
  }

  function clean(value, fallback = "未命名", max = 80) {
    return (String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback).slice(0, max);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function b64ToBytes(value) {
    const binary = atob(String(value || "").replace(/\s+/g, ""));
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
    return { ...body, data: JSON.parse(pako.inflate(b64ToBytes(compressed), { to: "string" })) };
  }

  async function apiGet(path, params = {}) {
    const base = currentApi();
    if (!base) throw new Error("网页 API 尚未连接");
    const url = new URL(String(path || "").replace(/^\/+/, ""), base);
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

  function authorUid(value) {
    const video = videoOf(value);
    return String(video.publisherId ?? video.publisherUID ?? video.publisherUid ?? video.user?.uid ?? value?.publisherId ?? "").trim();
  }

  function seedOf(value) {
    const video = videoOf(value);
    return video.user || value?.user || { uid: authorUid(value) };
  }

  function parseCatalog() {
    try {
      const parsed = JSON.parse($("#catalog-json")?.textContent || "{}");
      const payload = parsed?.decoded?.data ?? parsed?.decoded ?? parsed?.data ?? parsed;
      return findArray(payload).filter((item) => authorUid(item));
    } catch {
      return [];
    }
  }

  async function getAuthor(uid, seed = {}) {
    uid = String(uid || "").trim();
    if (!uid) return { uid: "", username: "未知作者" };
    if (state.authors.has(uid)) return state.authors.get(uid);
    if (state.authorRequests.has(uid)) return state.authorRequests.get(uid);

    const request = (async () => {
      try {
        const path = String(cfg.authorInfoPath || "users/{uid}/info").replace("{uid}", encodeURIComponent(uid));
        const response = await apiGet(path, { pid: cfg.pid || "PH" });
        const raw = response.data?.user || response.data || {};
        const author = { ...seed, ...raw, uid: raw.uid ?? uid, __raw: response };
        state.authors.set(uid, author);
        return author;
      } catch (error) {
        const author = { ...seed, uid, username: seed.username || `UID ${uid}`, __error: error.message || String(error) };
        state.authors.set(uid, author);
        return author;
      } finally {
        state.authorRequests.delete(uid);
      }
    })();
    state.authorRequests.set(uid, request);
    return request;
  }

  function normalizeWork(value, index) {
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

  async function fetchAllWorks(uid, progress) {
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
      progress?.(page, output.length);
      if (!items.length || !added || items.length < 20) break;
    }
    return output;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function permission(handle, request = false) {
    if (!handle) return false;
    try {
      if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
      if (request && (await handle.requestPermission({ mode: "readwrite" })) === "granted") return true;
    } catch {
      return false;
    }
    return false;
  }

  async function getRoot() {
    const stored = await idbGet(ROOT_KEY).catch(() => null);
    if (stored && await permission(stored, true)) return stored;
    if (typeof showDirectoryPicker !== "function") throw new Error("请使用最新版 Edge 或 Chrome 选择归档总目录");
    const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-all-authors-root" });
    if (!(await permission(handle, true))) throw new Error("没有所选目录的读写权限");
    await idbSet(ROOT_KEY, handle);
    return handle;
  }

  async function writeFile(directory, name, value) {
    const handle = await directory.getFileHandle(clean(name, "file", 160), { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(value); }
    finally { await writable.close(); }
  }

  async function writeJson(directory, name, value) {
    await writeFile(directory, name, JSON.stringify(value, null, 2));
  }

  async function readJson(directory, name, fallback) {
    try {
      const handle = await directory.getFileHandle(name);
      return JSON.parse(await (await handle.getFile()).text());
    } catch {
      return fallback;
    }
  }

  async function archiveAuthor(uid, seed = {}, button = null) {
    uid = String(uid || "").trim();
    if (!uid) throw new Error("作者 UID 为空");
    if (state.archiveRequests.has(uid)) return state.archiveRequests.get(uid);

    const request = (async () => {
      if (button) { button.disabled = true; setText(button, "正在读取作者…"); }
      const root = await getRoot();
      const author = await getAuthor(uid, seed);
      const username = author.username || `UID${uid}`;
      const folderName = `${clean(username, `UID${uid}`, 60)}_UID${uid}`;
      const directory = await root.getDirectoryHandle(folderName, { create: true });

      if (button) setText(button, "正在读取全部作品…");
      const rawWorks = await fetchAllWorks(uid, (page, count) => {
        if (button) setText(button, `第${page}页 · ${count}条`);
      });
      const works = rawWorks.map(normalizeWork);
      await writeJson(directory, "author.raw.json", author.__raw || author);
      await writeJson(directory, "author.json", {
        id: author.id || "",
        uid: author.uid ?? uid,
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
      await writeJson(directory, "works.raw.json", rawWorks);
      await writeJson(directory, "works.json", works);
      await writeFile(directory, "works.csv", csv(works));
      await directory.getDirectoryHandle("works", { create: true });
      const exportState = await readJson(directory, "export-state.json", { completed: [], failed: {} });
      exportState.updatedAt = new Date().toISOString();
      exportState.uid = uid;
      exportState.author = username;
      await writeJson(directory, "export-state.json", exportState);

      const result = { uid, username, works: works.length, folderName, rootName: root.name };
      log("作者全部作品元数据已保存", { ...result, workCoversSaved: 0 });
      return result;
    })().finally(() => state.archiveRequests.delete(uid));

    state.archiveRequests.set(uid, request);
    try {
      const result = await request;
      if (button) {
        button.disabled = false;
        setText(button, `已归档 ${result.works} 条`);
        setTimeout(() => setText(button, button.dataset.defaultText || "归档作者"), 2600);
      }
      return result;
    } catch (error) {
      if (button) {
        button.disabled = false;
        setText(button, "归档失败");
        setTimeout(() => setText(button, button.dataset.defaultText || "归档作者"), 2600);
      }
      throw error;
    }
  }

  async function waitForArchiveScan(panel) {
    const rescan = $("#aad-rescan", panel);
    if (!rescan) throw new Error("找不到归档中心的重新扫描按钮");
    rescan.click();
    await sleep(250);
    for (let index = 0; index < 900; index += 1) {
      const status = $("#aad-scan-status", panel)?.textContent || "";
      if (!rescan.disabled && !/正在扫描|扫描目录|读取目录/.test(status)) return;
      await sleep(100);
    }
    throw new Error("等待归档目录扫描超时");
  }

  function pageInfo(panel) {
    const match = ($("#aad-page-label", panel)?.textContent || "").match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
    return match ? { page: Number(match[1]), pages: Number(match[2]) } : { page: 1, pages: 1 };
  }

  async function queueAuthor(folderName, button) {
    if (!window.ALL_AUTHORS_ARCHIVE) throw new Error("全部作者归档中心尚未加载");
    window.ALL_AUTHORS_ARCHIVE.open();
    await sleep(80);
    const panel = $("#all-authors-center");
    if (!panel) throw new Error("全部作者归档中心界面尚未就绪");
    if (button) setText(button, "正在扫描归档…");
    await waitForArchiveScan(panel);

    const search = $("#aad-search", panel);
    search.value = folderName;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);

    for (let guard = 0; guard < 200 && pageInfo(panel).page > 1; guard += 1) {
      $("#aad-prev", panel)?.click();
      await sleep(40);
    }

    let queued = 0;
    for (let guard = 0; guard < 20000; guard += 1) {
      const eligible = $("[data-aad-enqueue]:not(:disabled)", panel);
      if (eligible) {
        eligible.click();
        queued += 1;
        if (button) setText(button, `已加入 ${queued} 条…`);
        await sleep(45);
        continue;
      }
      const info = pageInfo(panel);
      if (info.page >= info.pages) break;
      $("#aad-next", panel)?.click();
      await sleep(80);
    }
    log("指定作者作品已加入下载队列", { folderName, queued });
    return queued;
  }

  async function downloadAuthor(uid, seed, button) {
    const defaultText = button?.dataset.defaultText || "下载全部视频";
    try {
      if (button) { button.disabled = true; setText(button, "正在归档作者…"); }
      const result = await archiveAuthor(uid, seed, null);
      const queued = await queueAuthor(result.folderName, button);
      if (button) setText(button, queued ? `已加入 ${queued} 条` : "没有待下载作品");
    } catch (error) {
      log("下载指定作者全部视频失败", { uid, error: error.message || String(error) }, "error");
      if (button) setText(button, "操作失败");
      alert(error.message || error);
    } finally {
      setTimeout(() => {
        if (button?.isConnected) {
          button.disabled = false;
          setText(button, defaultText);
        }
      }, 3200);
    }
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(String(value)); }
    catch {
      const area = document.createElement("textarea");
      area.value = String(value);
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
    modal.innerHTML = `<div class="tag-author-dialog"><button type="button" class="tag-author-close">×</button><div id="tag-author-modal-body"></div></div>`;
    document.body.append(modal);
    modal.onclick = (event) => {
      if (event.target === modal || event.target.closest(".tag-author-close")) modal.hidden = true;
    };
    return modal;
  }

  async function showAuthor(uid, seed) {
    const modal = ensureModal();
    const body = $("#tag-author-modal-body", modal);
    modal.hidden = false;
    body.innerHTML = `<p>正在读取作者 ${escapeHtml(uid)}…</p>`;
    const author = await getAuthor(uid, seed);
    const username = author.username || `UID ${uid}`;
    body.innerHTML = `<p class="tag-author-eyebrow">AUTHOR PROFILE</p><h2>${escapeHtml(username)}</h2>
      <dl class="tag-author-profile"><div><dt>作者 UID</dt><dd>${escapeHtml(uid)}</dd></div><div><dt>作品数</dt><dd>${escapeHtml(author.videoCnt ?? "—")}</dd></div><div><dt>粉丝数</dt><dd>${escapeHtml(author.followerCnt ?? "—")}</dd></div><div><dt>获赞数</dt><dd>${escapeHtml(author.likedCnt ?? "—")}</dd></div></dl>
      <p>${escapeHtml(author.introduce || author.signature || "没有作者简介")}</p>
      <div class="tag-author-modal-actions"><button type="button" data-copy>复制作者 ID</button><button type="button" data-archive>归档作者</button><button type="button" data-download>下载该作者全部视频</button></div>`;
    $("[data-copy]", body).onclick = async (event) => { await copyText(uid); setText(event.currentTarget, "已复制"); };
    const archive = $("[data-archive]", body);
    archive.dataset.defaultText = "归档作者";
    archive.onclick = () => archiveAuthor(uid, author, archive).catch((error) => alert(error.message || error));
    const download = $("[data-download]", body);
    download.dataset.defaultText = "下载该作者全部视频";
    download.onclick = () => downloadAuthor(uid, author, download);
  }

  function decorateCard(card, item, index) {
    const uid = authorUid(item);
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

    const meta = $(".video-meta", card) || card;
    let authorLine = $(".tag-author-line", meta);
    if (!authorLine) {
      authorLine = document.createElement("small");
      authorLine.className = "tag-author-line";
      meta.append(authorLine);
    }
    const cached = state.authors.get(uid);
    setText(authorLine, `作者：${cached?.username || "加载中"} · UID ${uid}`);

    let idLine = $(".tag-video-id-line", meta);
    if (!idLine) {
      idLine = document.createElement("small");
      idLine.className = "tag-video-id-line";
      meta.append(idLine);
    }
    setText(idLine, `视频 ID：${id || "—"}`);

    let actions = $(".tag-author-actions", wrapper);
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "tag-author-actions";
      actions.innerHTML = `<button type="button" data-view>查看作者</button><button type="button" data-copy class="ghost-button">复制作者 ID</button><button type="button" data-archive class="ghost-button">归档作者</button><button type="button" data-download>下载全部视频</button>`;
      wrapper.append(actions);
    }

    const seed = seedOf(item);
    $("[data-view]", actions).onclick = () => showAuthor(uid, seed);
    $("[data-copy]", actions).onclick = async (event) => {
      await copyText(uid);
      setText(event.currentTarget, "已复制");
      setTimeout(() => setText(event.currentTarget, "复制作者 ID"), 1400);
    };
    const archive = $("[data-archive]", actions);
    archive.dataset.defaultText = "归档作者";
    archive.onclick = () => archiveAuthor(uid, seed, archive).catch((error) => alert(error.message || error));
    const download = $("[data-download]", actions);
    download.dataset.defaultText = "下载全部视频";
    download.onclick = () => downloadAuthor(uid, seed, download);

    getAuthor(uid, seed).then((author) => {
      if (authorLine.isConnected && card.dataset.publisherId === uid) setText(authorLine, `作者：${author.username || `UID ${uid}`} · UID ${uid}`);
    });
  }

  function decorate() {
    state.timer = 0;
    const parsed = parseCatalog();
    if (parsed.length) state.items = parsed;
    const cards = $$("#video-list .video-card");
    cards.forEach((card, index) => {
      if (state.items[index]) decorateCard(card, state.items[index], index);
    });
  }

  function schedule() {
    if (state.timer) return;
    state.timer = setTimeout(decorate, 50);
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.id = "tag-author-tools-styles";
    style.textContent = `.tag-author-card-wrap{min-width:0;display:flex;flex-direction:column;border:1px solid rgba(125,140,255,.2);border-radius:14px;overflow:hidden;background:rgba(12,18,34,.82)}.tag-author-card-wrap>.video-card{width:100%;border:0!important;border-radius:0!important;flex:1}.tag-author-line{display:block;margin-top:5px;color:#75dfc7!important;font-weight:700;overflow-wrap:anywhere}.tag-video-id-line{display:block;margin-top:3px;color:#8f9ab8!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.tag-author-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-top:1px solid rgba(125,140,255,.16)}.tag-author-actions button{min-width:0;padding:7px 6px;font-size:11px;white-space:normal}.tag-author-modal{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:20px;background:rgba(2,5,13,.82);backdrop-filter:blur(8px)}.tag-author-modal[hidden]{display:none}.tag-author-dialog{position:relative;width:min(620px,100%);max-height:88vh;overflow:auto;padding:24px;border:1px solid rgba(125,140,255,.3);border-radius:18px;background:#10172a}.tag-author-close{position:absolute;right:12px;top:10px;width:36px;height:36px;padding:0;border-radius:50%;font-size:24px}.tag-author-eyebrow{margin:0 0 6px;color:#75dfc7;font-size:11px;letter-spacing:.12em}.tag-author-profile{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}.tag-author-profile div{padding:10px;border-radius:10px;background:rgba(255,255,255,.05)}.tag-author-profile dt{font-size:11px;color:#96a0ba}.tag-author-profile dd{margin:4px 0 0;font-weight:700;overflow-wrap:anywhere}.tag-author-modal-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}@media(max-width:720px){.tag-author-modal-actions,.tag-author-profile,.tag-author-actions{grid-template-columns:1fr}}`;
    document.head.append(style);
  }

  function boot() {
    injectStyles();
    ensureModal();
    const catalog = $("#catalog-json");
    const list = $("#video-list");
    if (catalog) new MutationObserver(schedule).observe(catalog, { childList: true, subtree: true, characterData: true });
    if (list) new MutationObserver(schedule).observe(list, { childList: true, subtree: true });
    schedule();
    window.TAG_AUTHOR_TOOLS = { version: VERSION, refresh: decorate, getAuthor, archiveAuthor, downloadAuthor, get items() { return state.items.slice(); } };
    log("标签作者显示与指定作者归档工具已加载；作品封面只在实际下载时保存");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
