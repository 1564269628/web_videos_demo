(() => {
  "use strict";

  const VERSION = "20260803-33-multi-time-type";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const activeTagId = String(new URL(location.href).searchParams.get("tagId") || "").trim();
  if (!activeTagId) return;

  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const PAGE_SIZE = 20;
  const MAX_PAGES = 10000;
  const inFlight = new Map();

  const $ = (selector, root = document) => root.querySelector(selector);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(message, details, level = "log") {
    console[level](`[TAG ARCHIVE FIX ${VERSION}] ${message}`, details ?? "");
    const output = $("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    output.textContent = `[${time}] [标签归档修复] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
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
    const requestFetch = window.__nativeFetch || window.fetch.bind(window);
    const response = await requestFetch(url.href, {
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
    return String(video.id ?? video.videoId ?? video.vid ?? value?.id ?? "").trim();
  }

  function authorUid(value) {
    const video = videoOf(value);
    return String(video.publisherId ?? video.publisherUID ?? video.publisherUid ?? video.user?.uid ?? value?.publisherId ?? "").trim();
  }

  function preferredTimeType(value) {
    const video = videoOf(value);
    const type = Number(video.timeType ?? value?.timeType);
    return Number.isInteger(type) && type > 0 ? type : 0;
  }

  function findSeed(uid) {
    const items = window.TAG_AUTHOR_TOOLS?.items || [];
    return items.find((item) => authorUid(item) === String(uid)) || { publisherId: String(uid) };
  }

  function uniqueTimeTypes(seed) {
    const values = [preferredTimeType(seed), 2, 3, 1];
    return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
  }

  function mergeByVideoId(...groups) {
    const output = [];
    const seen = new Set();
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        const id = videoId(item);
        const key = id || `anonymous:${JSON.stringify(item)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(item);
      }
    }
    return output;
  }

  async function fetchAllWorks(uid, seed, onProgress) {
    const path = String(cfg.authorVideosPath || "users/{uid}/videos").replace("{uid}", encodeURIComponent(uid));
    const types = uniqueTimeTypes(seed);
    const output = [];
    const seen = new Set();
    const countsByType = {};

    for (const timeType of types) {
      let typeTotal = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await apiGet(path, {
          timeType,
          page,
          pageSize: PAGE_SIZE,
          pid: cfg.pid || "PH"
        });
        const items = findArray(response.data);
        let added = 0;
        for (const item of items) {
          const id = videoId(item) || `${timeType}:${page}:${typeTotal}`;
          if (seen.has(id)) continue;
          seen.add(id);
          output.push(item);
          added += 1;
          typeTotal += 1;
        }
        countsByType[timeType] = typeTotal;
        onProgress?.({ timeType, page, typeTotal, total: output.length, received: items.length });
        if (!items.length || !added || items.length < PAGE_SIZE) break;
      }
    }

    return { items: output, countsByType, timeTypes: types };
  }

  function normalizeWork(value, index) {
    const work = videoOf(value);
    const tags = Array.isArray(work.videoTags)
      ? work.videoTags
      : Array.isArray(work.tags)
        ? work.tags.map((tag) => typeof tag === "string" ? tag : tag?.name).filter(Boolean)
        : [];
    return {
      index: index + 1,
      id: videoId(value),
      title: work.title || work.name || "",
      description: work.description || work.summary || work.introduce || "",
      tags,
      timeType: Number(work.timeType || value?.timeType || 0),
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
    const keys = ["index", "id", "title", "description", "tags", "timeType", "durationSeconds", "width", "height", "playCount", "likeCount", "commentCount", "collectCount", "releaseDate", "releaseDateLabel", "coverPath", "playPath", "signedPlaylistUrl"];
    const quote = (value) => `"${(Array.isArray(value) ? value.join("|") : String(value ?? "")).replace(/"/g, '""')}"`;
    return `\ufeff${keys.join(",")}\n${rows.map((row) => keys.map((key) => quote(row[key])).join(",")).join("\n")}\n`;
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

  async function getAuthor(uid, seed) {
    if (window.TAG_AUTHOR_TOOLS?.getAuthor) {
      return window.TAG_AUTHOR_TOOLS.getAuthor(uid, videoOf(seed).user || seed?.user || { uid });
    }
    return { uid, username: `UID ${uid}` };
  }

  async function archiveAuthor(uid, seed = {}, button = null) {
    uid = String(uid || "").trim();
    if (!uid) throw new Error("作者 UID 为空");
    if (inFlight.has(uid)) return inFlight.get(uid);

    const task = (async () => {
      const oldText = button?.textContent || "归档作者";
      if (button) { button.disabled = true; button.textContent = "正在读取作者…"; }
      try {
        const root = await getRoot();
        const author = await getAuthor(uid, seed);
        const username = author.username || `UID${uid}`;
        const folderName = `${clean(username, `UID${uid}`, 60)}_UID${uid}`;
        const directory = await root.getDirectoryHandle(folderName, { create: true });
        const existingRaw = await readJson(directory, "works.raw.json", []);

        if (button) button.textContent = "正在扫描多种视频类型…";
        const fetched = await fetchAllWorks(uid, seed, ({ timeType, page, typeTotal, total }) => {
          if (button) button.textContent = `类型${timeType} 第${page}页 · 共${total}条`;
          log("作者作品分页返回", { uid, timeType, page, typeTotal, total });
        });

        if (!fetched.items.length) {
          const preserved = Array.isArray(existingRaw) ? existingRaw.length : 0;
          throw new Error(`服务器在 timeType=${fetched.timeTypes.join("/")} 下均返回 0 条；已保留原有 ${preserved} 条，没有覆盖 works.json`);
        }

        const rawWorks = mergeByVideoId(existingRaw, fetched.items);
        const works = rawWorks.map(normalizeWork);
        await writeJson(directory, "author.raw.json", author.__raw || author);
        await writeJson(directory, "author.json", {
          id: author.id || "",
          uid: author.uid ?? uid,
          username,
          signature: author.introduce || author.signature || "",
          videoCount: works.length,
          serverVideoCount: author.videoCnt ?? null,
          followerCount: author.followerCnt ?? null,
          likedCount: author.likedCnt ?? null,
          collectCount: author.collectCnt ?? null,
          avatarPath: author.avatarURL || "",
          backgroundPath: author.bgCoverUrl || "",
          scannedFromTagAt: new Date().toISOString(),
          scannedTimeTypes: fetched.timeTypes,
          countsByTimeType: fetched.countsByType
        });
        await writeJson(directory, "works.raw.json", rawWorks);
        await writeJson(directory, "works.json", works);
        await writeFile(directory, "works.csv", csv(works));
        await writeJson(directory, "archive-query.json", {
          uid,
          requestedAt: new Date().toISOString(),
          preferredTimeType: preferredTimeType(seed) || null,
          scannedTimeTypes: fetched.timeTypes,
          countsByTimeType: fetched.countsByType,
          fetchedUnique: fetched.items.length,
          existingBeforeMerge: Array.isArray(existingRaw) ? existingRaw.length : 0,
          savedUnique: works.length
        });
        await directory.getDirectoryHandle("works", { create: true });

        const exportState = await readJson(directory, "export-state.json", { completed: [], failed: {} }) || { completed: [], failed: {} };
        exportState.updatedAt = new Date().toISOString();
        exportState.uid = uid;
        exportState.author = username;
        await writeJson(directory, "export-state.json", exportState);

        const result = {
          uid,
          username,
          folderName,
          works: works.length,
          fetched: fetched.items.length,
          countsByTimeType: fetched.countsByType,
          rootName: root.name
        };
        log("作者多类型作品归档完成", result);
        if (button) button.textContent = `已归档 ${works.length} 条`;
        return result;
      } catch (error) {
        log("作者多类型归档失败", { uid, error: error.message || String(error) }, "error");
        if (button) button.textContent = "归档失败";
        throw error;
      } finally {
        if (button) {
          setTimeout(() => {
            if (button.isConnected) {
              button.disabled = false;
              button.textContent = oldText;
            }
          }, 3500);
        }
      }
    })().finally(() => inFlight.delete(uid));

    inFlight.set(uid, task);
    return task;
  }

  function parsePageLabel() {
    const text = $("#aad-page-label")?.textContent || "";
    const match = text.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
    return match ? { page: Number(match[1]), pages: Number(match[2]) } : null;
  }

  async function queueAuthor(folderName, button) {
    if (!window.ALL_AUTHORS_ARCHIVE) throw new Error("全部作者下载中心尚未加载");
    await window.ALL_AUTHORS_ARCHIVE.scan?.();
    window.ALL_AUTHORS_ARCHIVE.open?.();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ($("#aad-search") && $("#aad-works")) break;
      await sleep(50);
    }
    const search = $("#aad-search");
    if (!search) throw new Error("没有找到全部作者中心的搜索框");
    search.value = folderName;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);

    let queued = 0;
    for (let guard = 0; guard < 1000; guard += 1) {
      let clickedOnPage = 0;
      while (true) {
        const enqueue = $("#aad-works [data-aad-enqueue]:not([disabled])");
        if (!enqueue) break;
        enqueue.click();
        queued += 1;
        clickedOnPage += 1;
        if (button) button.textContent = `已加入 ${queued} 条…`;
        await sleep(15);
      }

      const paging = parsePageLabel();
      if (!paging || paging.page >= paging.pages) break;
      const before = $("#aad-page-label")?.textContent || "";
      $("#aad-next")?.click();
      await sleep(80);
      const after = $("#aad-page-label")?.textContent || "";
      if (before === after && clickedOnPage === 0) break;
    }
    log("指定作者作品已加入下载队列", { folderName, queued });
    return queued;
  }

  async function downloadAuthor(uid, seed, button) {
    const oldText = button?.textContent || "下载全部视频";
    try {
      if (button) { button.disabled = true; button.textContent = "正在完整归档作者…"; }
      const result = await archiveAuthor(uid, seed, null);
      const queued = await queueAuthor(result.folderName, button);
      if (button) button.textContent = queued ? `已加入 ${queued} 条` : "没有待下载作品";
    } catch (error) {
      if (button) button.textContent = "操作失败";
      alert(error.message || error);
    } finally {
      setTimeout(() => {
        if (button?.isConnected) {
          button.disabled = false;
          button.textContent = oldText;
        }
      }, 3500);
    }
  }

  function uidFromButton(button) {
    const wrapper = button.closest(".tag-author-card-wrap");
    if (wrapper?.dataset.publisherId) return wrapper.dataset.publisherId;
    const modal = button.closest("#tag-author-modal-body");
    if (modal) {
      const firstValue = modal.querySelector(".tag-author-profile dd")?.textContent || "";
      const match = firstValue.match(/\d+/);
      if (match) return match[0];
    }
    return "";
  }

  document.addEventListener("click", (event) => {
    const archiveButton = event.target.closest?.("[data-author-archive],[data-modal-archive]");
    const downloadButton = event.target.closest?.("[data-author-download],[data-modal-download]");
    const button = archiveButton || downloadButton;
    if (!button) return;
    const uid = uidFromButton(button);
    if (!uid) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const seed = findSeed(uid);
    if (downloadButton) downloadAuthor(uid, seed, button);
    else archiveAuthor(uid, seed, button).catch((error) => alert(error.message || error));
  }, true);

  window.TAG_AUTHOR_ARCHIVE_FIX = {
    version: VERSION,
    archiveAuthor,
    downloadAuthor,
    getTimeTypes: uniqueTimeTypes
  };
  log("标签作者归档修复已加载：按标签类型、timeType 2/3/1 合并抓取，0 条不再覆盖本地归档");
})();
