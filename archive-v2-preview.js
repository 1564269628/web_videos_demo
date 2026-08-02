(() => {
  "use strict";

  const VERSION = "20260802-20-preview";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  const DB_NAME = "hq-archive-v2-preview";
  const DB_VERSION = 1;
  const HANDLE_STORE = "handles";
  const ARCHIVE_ROOT_KEY = "archive-root";
  const EXISTING_DB = "hq-archive-center";
  const EXISTING_STORE = "handles";
  const CURRENT_AUTHOR_KEY = "last-author-folder";

  const state = {
    archiveRoot: null,
    currentAuthor: null,
    currentAuthorData: null,
    currentWorks: [],
    currentIndex: null,
    globalById: new Map(),
    globalByTitle: new Map(),
    duplicates: new Map(),
    scanningRoot: false,
    deduping: false,
    scannerRunning: false,
    scannerCancelled: false,
    scanController: null,
    playerHls: null,
    playerUrls: [],
    observer: null,
    lastFolderName: ""
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uniq = (values) => [...new Set(values.filter(Boolean))];

  function log(message, details, level = "log") {
    console[level](`[ARCHIVE V2 ${VERSION}] ${message}`, details || "");
    const output = $("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeJson(details)}`;
    const line = `[${time}] [归档 V2] ${message}${suffix}\n`;
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `${line}${old}`.slice(0, 180000);
  }

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function clean(value, fallback = "未命名", max = 80) {
    return (String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback).slice(0, max);
  }

  function normalizedTitle(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}_]+/gu, "")
      .trim();
  }

  function titleKey(work) {
    const title = normalizedTitle(work.title || work.name || "");
    const duration = Math.max(0, Math.round(Number(work.durationSeconds || work.time || 0)));
    return title ? `${title}::${duration}` : "";
  }

  function workId(work) {
    return String(work?.id ?? work?.videoId ?? work?.vid ?? "");
  }

  function videoOf(item) {
    return item?.video && typeof item.video === "object" ? item.video : item || {};
  }

  function itemVideoId(item) {
    const video = videoOf(item);
    return String(video.id ?? video.vid ?? video.videoId ?? item?.id ?? "");
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
      id: itemVideoId(value),
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
      signedPlaylistUrl: value?.url || work.url || work.signedPlaylistUrl || "",
      rawAuthor: work.user || value?.user || null
    };
  }

  function workFolderName(work) {
    return `${String(work.index || 0).padStart(5, "0")}_${clean(work.title || work.id, work.id || "video", 56)}_${clean(work.id, "id", 32)}`;
  }

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || "").trim());
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

  function token() {
    return localStorage.getItem(cfg.storageKeys?.token || "hq-video-token") || "";
  }

  function openDb(name = DB_NAME, version = DB_VERSION, store = HANDLE_STORE) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key, name = DB_NAME, store = HANDLE_STORE) {
    const db = await openDb(name, undefined, store);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbSet(key, value, name = DB_NAME, store = HANDLE_STORE) {
    const db = await openDb(name, undefined, store);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function permission(handle, request = false) {
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

  async function readFile(directory, name) {
    return (await directory.getFileHandle(name)).getFile();
  }

  async function readJson(directory, name, fallback = null) {
    try { return JSON.parse(await (await readFile(directory, name)).text()); }
    catch { return fallback; }
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

  async function fileExists(directory, name) {
    try { return (await (await directory.getFileHandle(name)).getFile()).size > 0; }
    catch { return false; }
  }

  async function firstExistingFile(directory, names) {
    for (const name of names) {
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        if (file.size > 0) return { name, handle, file };
      } catch {
        // Try next.
      }
    }
    return null;
  }

  function b64ToBytes(value) {
    const binary = atob(String(value || "").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesToB64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  function wordArrayBytes(wordArray) {
    const bytes = new Uint8Array(wordArray?.sigBytes || 0);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 255;
    }
    return bytes;
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

  async function fetchTimed(url, init = {}, timeoutMs = 18000, parentSignal = state.scanController?.signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason || "cancelled");
    if (parentSignal) parentSignal.aborted ? abort() : parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try { return await nativeFetch(url, { ...init, signal: controller.signal }); }
    finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    }
  }

  async function apiGet(path, params = {}) {
    const api = currentApi();
    if (!api) throw new Error("网页 API 尚未连接");
    const url = new URL(joinUrl(api, path));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const response = await fetchTimed(url.href, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
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

  function resourceDomains() {
    let dynamic = [];
    try {
      const raw = JSON.parse($("#domain-json")?.textContent || "{}");
      const data = raw?.decoded?.data || raw?.decoded || raw?.data || raw;
      dynamic = data?.resDomains || data?.resourceDomains || [];
    } catch {
      dynamic = [];
    }
    return uniq([currentResource(), ...(Array.isArray(dynamic) ? dynamic : [dynamic])].map(normalizeBase));
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 12)).includes("ftypavi")) return "image/avif";
    return "";
  }

  function decodeImage(bytes) {
    const direct = detectImageMime(bytes);
    if (direct) return { bytes, type: direct };
    const decrypted = CryptoJS.AES.decrypt(
      bytesToB64(bytes),
      CryptoJS.enc.Utf8.parse(cfg.imageAesKey || "82758dd12749c777ef579f1839ceea6a"),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    let text = "";
    try { text = CryptoJS.enc.Utf8.stringify(decrypted).replace(/\0+$/g, "").trim(); }
    catch { text = ""; }
    if (/^data:image\//i.test(text)) {
      const comma = text.indexOf(",");
      return { bytes: b64ToBytes(text.slice(comma + 1)), type: text.slice(5, text.indexOf(";")) || "image/webp" };
    }
    if (text.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try {
        const decoded = b64ToBytes(text);
        const type = detectImageMime(decoded);
        if (type) return { bytes: decoded, type };
      } catch {
        // Binary fallback.
      }
    }
    const decoded = wordArrayBytes(decrypted);
    const type = detectImageMime(decoded);
    if (!type) throw new Error("图片解密后格式未知");
    return { bytes: decoded, type };
  }

  function imageExtension(type) {
    return ({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/avif": "avif"
    })[type] || "bin";
  }

  async function getRemoteImage(path, size = 720) {
    if (!path) throw new Error("图片路径为空");
    const candidates = [];
    for (const domain of resourceDomains()) {
      const original = joinUrl(domain, path);
      if (/\.(ceb|geb)(?:$|[?#])/i.test(original)) candidates.push(`${original}@webp-${size}`);
      candidates.push(original);
    }
    const errors = [];
    for (const candidate of uniq(candidates)) {
      try {
        const response = await fetchTimed(candidate, { cache: "force-cache", credentials: "omit", mode: "cors" }, 15000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error("空响应");
        return decodeImage(bytes);
      } catch (error) {
        errors.push(`${candidate}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | ") || "没有图片资源线路");
  }

  function csv(rows) {
    const keys = ["index", "id", "title", "description", "tags", "durationSeconds", "width", "height", "playCount", "likeCount", "commentCount", "collectCount", "releaseDate", "releaseDateLabel", "coverPath", "playPath"];
    const quote = (value) => `"${(Array.isArray(value) ? value.join("|") : String(value ?? "")).replace(/"/g, '""')}"`;
    return `\ufeff${keys.join(",")}\n${rows.map((row) => keys.map((key) => quote(row[key])).join(",")).join("\n")}\n`;
  }

  async function chooseArchiveRoot() {
    if (typeof showDirectoryPicker !== "function") {
      alert("请使用最新版 Edge 或 Chrome。当前浏览器不支持直接读写文件夹。");
      return false;
    }
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-video-archive-root" });
      if (!(await permission(handle, true))) throw new Error("没有文件夹读写权限");
      state.archiveRoot = handle;
      await idbSet(ARCHIVE_ROOT_KEY, handle);
      await buildGlobalIndex();
      updateDedupeStatus();
      return true;
    } catch (error) {
      if (error.name !== "AbortError") alert(error.message || error);
      return false;
    }
  }

  async function restoreArchiveRoot(request = false) {
    try {
      const handle = await idbGet(ARCHIVE_ROOT_KEY);
      if (!handle || !(await permission(handle, request))) return false;
      state.archiveRoot = handle;
      await buildGlobalIndex();
      updateDedupeStatus();
      return true;
    } catch (error) {
      log("恢复归档总目录失败", error.message, "warn");
      return false;
    }
  }

  async function currentAuthorHandle() {
    try {
      const handle = await idbGet(CURRENT_AUTHOR_KEY, EXISTING_DB, EXISTING_STORE);
      if (!handle || !(await permission(handle, false))) return null;
      return handle;
    } catch {
      return null;
    }
  }

  async function resolveWorkFile(authorDir, work, indexEntry = {}) {
    const worksDir = await authorDir.getDirectoryHandle("works");
    const folderName = indexEntry.folderName || workFolderName(work);
    let workDir;
    try { workDir = await worksDir.getDirectoryHandle(folderName); }
    catch {
      for await (const [name, handle] of worksDir.entries()) {
        if (handle.kind !== "directory") continue;
        if (name.startsWith(`${String(work.index || 0).padStart(5, "0")}_`) || name.endsWith(`_${clean(work.id, "id", 32)}`)) {
          workDir = handle;
          break;
        }
      }
    }
    if (!workDir) return null;
    const file = await firstExistingFile(workDir, [indexEntry.videoFile, "video.mp4", "video.ts"].filter(Boolean));
    return file ? { ...file, workDir, folderName: workDir.name } : null;
  }

  function addSourceToGlobal(source) {
    if (source.id && !state.globalById.has(source.id)) state.globalById.set(source.id, source);
    const key = titleKey(source.work);
    if (key) {
      const list = state.globalByTitle.get(key) || [];
      list.push(source);
      state.globalByTitle.set(key, list);
    }
  }

  async function buildGlobalIndex() {
    if (!state.archiveRoot || state.scanningRoot) return;
    state.scanningRoot = true;
    state.globalById.clear();
    state.globalByTitle.clear();
    let authors = 0;
    let files = 0;
    try {
      updateDedupeStatus("正在扫描归档总目录…");
      for await (const [folderName, authorDir] of state.archiveRoot.entries()) {
        if (authorDir.kind !== "directory") continue;
        const author = await readJson(authorDir, "author.json", null);
        const worksRaw = await readJson(authorDir, "works.json", null);
        if (!author || !Array.isArray(worksRaw)) continue;
        authors += 1;
        const works = worksRaw.map(normalizeWork);
        const index = await readJson(authorDir, "archive-index.json", { items: {} }) || { items: {} };
        const exportState = await readJson(authorDir, "export-state.json", {}) || {};
        const completed = new Set(exportState.completed || []);
        for (const work of works) {
          const entry = index.items?.[work.id] || {};
          const logicallyDone = entry.status === "downloaded" || completed.has(work.id);
          if (!logicallyDone) continue;
          const resolved = await resolveWorkFile(authorDir, work, entry).catch(() => null);
          if (!resolved) continue;
          files += 1;
          addSourceToGlobal({
            id: work.id,
            work,
            author,
            authorFolder: folderName,
            authorDir,
            workFolder: resolved.folderName,
            videoFile: resolved.name,
            byteLength: resolved.file.size,
            segmentCount: Number(entry.segmentCount || 0)
          });
        }
        if (authors % 5 === 0) updateDedupeStatus(`已扫描 ${authors} 个作者、${files} 个本地视频`);
      }
      log("跨作者去重索引建立完成", { authors, localVideos: files });
    } finally {
      state.scanningRoot = false;
      updateDedupeStatus();
    }
  }

  function findDuplicate(work, currentFolder) {
    if (work.id) {
      const exact = state.globalById.get(work.id);
      if (exact && exact.authorFolder !== currentFolder) return { source: exact, reason: "视频 ID 相同" };
    }
    const key = titleKey(work);
    if (key) {
      const list = state.globalByTitle.get(key) || [];
      const source = list.find((entry) => entry.authorFolder !== currentFolder);
      if (source) return { source, reason: "规范化标题和时长相同" };
    }
    return null;
  }

  async function applyDedupeToCurrent() {
    if (state.deduping || !state.archiveRoot) return;
    const authorDir = await currentAuthorHandle();
    if (!authorDir || authorDir.name === state.lastFolderName && state.duplicates.size) {
      decorateDuplicateCards();
      return;
    }
    state.deduping = true;
    try {
      const author = await readJson(authorDir, "author.json", null);
      const worksRaw = await readJson(authorDir, "works.json", null);
      if (!author || !Array.isArray(worksRaw)) return;
      state.currentAuthor = authorDir;
      state.currentAuthorData = author;
      state.currentWorks = worksRaw.map(normalizeWork);
      state.lastFolderName = authorDir.name;
      const index = await readJson(authorDir, "archive-index.json", { version: VERSION, settings: {}, items: {} }) || { version: VERSION, settings: {}, items: {} };
      index.items ||= {};
      state.currentIndex = index;
      state.duplicates.clear();
      let changed = 0;
      const worksDir = await authorDir.getDirectoryHandle("works", { create: true });

      for (const work of state.currentWorks) {
        const existing = index.items[work.id] || {};
        const local = await resolveWorkFile(authorDir, work, existing).catch(() => null);
        if (local) continue;
        const duplicate = findDuplicate(work, authorDir.name);
        if (!duplicate) continue;
        state.duplicates.set(work.id, duplicate);
        const folderName = existing.folderName || workFolderName(work);
        const workDir = await worksDir.getDirectoryHandle(folderName, { create: true });
        await writeJson(workDir, "duplicate.json", {
          version: VERSION,
          detectedAt: new Date().toISOString(),
          reason: duplicate.reason,
          sourceAuthorFolder: duplicate.source.authorFolder,
          sourceWorkFolder: duplicate.source.workFolder,
          sourceVideoFile: duplicate.source.videoFile,
          sourceVideoId: duplicate.source.id,
          sourceTitle: duplicate.source.work.title
        });
        if (!(await fileExists(workDir, "metadata.json"))) await writeJson(workDir, "metadata.json", work);
        index.items[work.id] = {
          ...existing,
          folderName,
          status: "downloaded",
          segmentCount: duplicate.source.segmentCount || existing.segmentCount || null,
          videoFile: duplicate.source.videoFile,
          byteLength: duplicate.source.byteLength,
          completedAt: existing.completedAt || new Date().toISOString(),
          error: `跨作者去重：${duplicate.reason}；复用 ${duplicate.source.authorFolder}`,
          lastAttemptAt: new Date().toISOString()
        };
        changed += 1;
      }

      if (changed) {
        index.version = VERSION;
        index.updatedAt = new Date().toISOString();
        await writeJson(authorDir, "archive-index.json", index);
        log("当前作者跨作者去重完成", { author: author.username, duplicates: changed });
        const refresh = $("#archive-refresh-folder");
        if (refresh) setTimeout(() => refresh.click(), 80);
      }
      decorateDuplicateCards();
      updateDedupeStatus();
    } finally {
      state.deduping = false;
    }
  }

  function decorateDuplicateCards() {
    for (const card of $$(".archive-work-card[data-work-id]")) {
      const id = card.dataset.workId;
      const duplicate = state.duplicates.get(id);
      card.classList.toggle("archive-cross-duplicate", Boolean(duplicate));
      if (!duplicate) continue;
      const badge = $(".archive-work-status", card);
      if (badge) badge.textContent = "跨作者重复";
      let note = $(".archive-duplicate-note", card);
      if (!note) {
        note = document.createElement("p");
        note.className = "archive-duplicate-note";
        $(".archive-work-body", card)?.append(note);
      }
      note.textContent = `复用：${duplicate.source.authorFolder} · ${duplicate.reason}`;
      const play = $('[data-archive-action="play"]', card);
      if (play) play.textContent = "播放已有副本";
    }
  }

  function updateDedupeStatus(message = "") {
    const element = $("#archive-v2-dedupe-status");
    if (!element) return;
    if (message) {
      element.textContent = message;
      return;
    }
    element.textContent = state.archiveRoot
      ? `归档总目录：${state.archiveRoot.name} · 已索引 ${state.globalById.size} 个唯一 ID · 当前重复 ${state.duplicates.size} 条`
      : "尚未选择归档总目录，跨作者去重未启用";
  }

  function cleanupPlayer() {
    if (state.playerHls) {
      state.playerHls.destroy();
      state.playerHls = null;
    }
    for (const url of state.playerUrls) URL.revokeObjectURL(url);
    state.playerUrls = [];
  }

  async function sourceForItem(id) {
    const duplicate = state.duplicates.get(id);
    if (duplicate) return duplicate.source;
    const authorDir = state.currentAuthor || await currentAuthorHandle();
    if (!authorDir) throw new Error("没有当前作者文件夹权限");
    const works = state.currentWorks.length ? state.currentWorks : (await readJson(authorDir, "works.json", [])).map(normalizeWork);
    const work = works.find((entry) => entry.id === id);
    if (!work) throw new Error("本地作品元数据中没有该视频");
    const index = state.currentIndex || await readJson(authorDir, "archive-index.json", { items: {} });
    const entry = index.items?.[id] || {};
    const resolved = await resolveWorkFile(authorDir, work, entry);
    if (!resolved) throw new Error("没有找到本地视频文件");
    return {
      id,
      work,
      author: state.currentAuthorData || await readJson(authorDir, "author.json", {}),
      authorFolder: authorDir.name,
      authorDir,
      workFolder: resolved.folderName,
      videoFile: resolved.name,
      byteLength: resolved.file.size,
      segmentCount: Number(entry.segmentCount || 0)
    };
  }

  async function playSource(source) {
    const worksDir = await source.authorDir.getDirectoryHandle("works");
    const workDir = await worksDir.getDirectoryHandle(source.workFolder);
    const file = await (await workDir.getFileHandle(source.videoFile)).getFile();
    const player = $("#archive-local-player");
    if (!player) throw new Error("本地播放器尚未创建");
    cleanupPlayer();
    player.pause();
    player.removeAttribute("src");
    player.load();

    const title = $("#archive-player-title");
    const meta = $("#archive-player-meta");
    const description = $("#archive-player-description");
    const note = $("#archive-player-note");
    if (title) title.textContent = source.work.title || source.id;
    if (meta) meta.textContent = `${Math.round(source.work.durationSeconds || 0)} 秒 · ${(file.size / 1048576).toFixed(1)} MB · ${source.authorFolder}`;
    if (description) description.textContent = source.work.description || "暂无描述";
    if (note) note.textContent = "";

    const fileUrl = URL.createObjectURL(file);
    state.playerUrls.push(fileUrl);
    if (/\.mp4$/i.test(source.videoFile)) {
      player.src = fileUrl;
      player.load();
      try { await player.play(); }
      catch { if (note) note.textContent = "浏览器阻止自动播放，请点击播放按钮。"; }
      return;
    }

    if (!window.Hls?.isSupported()) {
      player.src = fileUrl;
      player.load();
      if (note) note.textContent = "浏览器不支持 HLS.js 的 TS 转封装，已尝试原生播放。";
      return;
    }

    const duration = Math.max(1, Number(source.work.durationSeconds || 3600));
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(duration)}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:${duration.toFixed(3)},\n${fileUrl}\n#EXT-X-ENDLIST\n`;
    const playlistUrl = URL.createObjectURL(new Blob([playlist], { type: "application/vnd.apple.mpegurl" }));
    state.playerUrls.push(playlistUrl);
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 60,
      backBufferLength: 30
    });
    state.playerHls = hls;
    hls.attachMedia(player);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playlistUrl));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      player.play().catch(() => {
        if (note) note.textContent = "TS 已通过 HLS.js 转封装，点击播放按钮开始播放。";
      });
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (note) note.textContent = `浏览器 TS 转封装失败：${data.details || data.type}。文件仍可用 VLC 或 PotPlayer 打开。`;
    });
  }

  async function interceptPlay(event) {
    const action = event.target.closest?.('[data-archive-action="play"]');
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const source = await sourceForItem(action.dataset.id);
      await playSource(source);
      $(".archive-center-player")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      alert(`本地播放失败：${error.message || error}`);
    }
  }

  function scannerPanel() {
    let panel = $("#archive-home-scanner");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "archive-home-scanner";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="archive-v2-backdrop"></div>
      <section class="archive-v2-dialog" role="dialog" aria-modal="true">
        <header><div><p>HOME FEED ARCHIVER</p><h2>首页作者批量扫描</h2></div><button type="button" id="archive-scan-close">关闭</button></header>
        <div class="archive-v2-form">
          <label>扫描首页页数 <input id="archive-scan-pages" type="number" min="1" max="100" value="20"></label>
          <label>作者处理并发 <input id="archive-scan-author-concurrency" type="number" min="1" max="5" value="2"></label>
          <label><input id="archive-scan-covers" type="checkbox" checked> 保存作者头像和所有作品封面</label>
          <label><input id="archive-scan-reuse" type="checkbox" checked> 已存在 author.json + works.json 时直接复用</label>
          <div class="archive-v2-actions">
            <button type="button" id="archive-scan-root">选择归档总目录</button>
            <button type="button" id="archive-scan-start">开始扫描</button>
            <button type="button" id="archive-scan-cancel">取消</button>
          </div>
          <p id="archive-scan-root-status">尚未选择归档总目录</p>
        </div>
        <div class="archive-v2-progress"><span></span></div>
        <pre id="archive-scan-log">等待开始…</pre>
      </section>`;
    document.body.append(panel);
    $("#archive-scan-close", panel).onclick = () => { if (!state.scannerRunning) panel.hidden = true; };
    $(".archive-v2-backdrop", panel).onclick = () => { if (!state.scannerRunning) panel.hidden = true; };
    $("#archive-scan-root", panel).onclick = async () => { await chooseArchiveRoot(); updateScannerRootStatus(); };
    $("#archive-scan-start", panel).onclick = startHomepageScan;
    $("#archive-scan-cancel", panel).onclick = () => {
      state.scannerCancelled = true;
      state.scanController?.abort("cancelled");
      scanLog("正在取消…");
    };
    return panel;
  }

  function scanLog(message, details) {
    const output = $("#archive-scan-log");
    if (!output) return;
    const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}${details ? `\n${safeJson(details)}` : ""}\n`;
    output.textContent = `${line}${output.textContent === "等待开始…" ? "" : output.textContent}`.slice(0, 100000);
  }

  function scanProgress(percent) {
    const bar = $("#archive-home-scanner .archive-v2-progress span");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
  }

  function updateScannerRootStatus() {
    const status = $("#archive-scan-root-status");
    if (status) status.textContent = state.archiveRoot ? `保存到：${state.archiveRoot.name}` : "尚未选择归档总目录";
  }

  async function fetchAuthorInfo(uid, fallback) {
    try {
      const path = String(cfg.authorInfoPath || "users/{uid}/info").replace("{uid}", encodeURIComponent(uid));
      const response = await apiGet(path, { pid: cfg.pid || "PH" });
      return { raw: response, author: response.data?.user || response.data || fallback };
    } catch (error) {
      return { raw: null, author: fallback, error: error.message || String(error) };
    }
  }

  async function fetchAllAuthorWorks(uid, onPage) {
    const path = String(cfg.authorVideosPath || "users/{uid}/videos").replace("{uid}", encodeURIComponent(uid));
    const output = [];
    const seen = new Set();
    for (let page = 1; page <= 10000; page += 1) {
      if (state.scannerCancelled) throw new DOMException("已取消", "AbortError");
      const response = await apiGet(path, { timeType: 3, page, pageSize: 20, pid: cfg.pid || "PH" });
      const items = findArray(response.data);
      let added = 0;
      for (const item of items) {
        const id = itemVideoId(item) || `${page}-${output.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        output.push(item);
        added += 1;
      }
      onPage?.(page, output.length);
      if (!items.length || !added || items.length < 20) break;
    }
    return output;
  }

  async function saveImageIfMissing(directory, baseName, path, size) {
    if (!path) return;
    const existing = await firstExistingFile(directory, [`${baseName}.webp`, `${baseName}.jpg`, `${baseName}.jpeg`, `${baseName}.png`, `${baseName}.avif`]);
    if (existing) return;
    const image = await getRemoteImage(path, size);
    await writeFile(directory, `${baseName}.${imageExtension(image.type)}`, image.bytes);
  }

  async function archiveOneAuthor(seed, saveCovers, reuseExisting, authorNumber, totalAuthors) {
    const uid = String(seed.uid ?? seed.id ?? "");
    if (!uid) return { status: "skipped", reason: "缺少 UID" };
    const fallbackName = seed.username || `UID${uid}`;
    const tentativeName = `${clean(fallbackName, `UID${uid}`, 60)}_UID${uid}`;
    let authorDir = await state.archiveRoot.getDirectoryHandle(tentativeName, { create: true });
    const existingAuthor = await readJson(authorDir, "author.json", null);
    const existingWorks = await readJson(authorDir, "works.json", null);
    if (reuseExisting && existingAuthor && Array.isArray(existingWorks)) {
      scanLog(`复用已有作者 ${authorNumber}/${totalAuthors}：${existingAuthor.username || fallbackName} · ${existingWorks.length} 条`);
      return { status: "reused", uid, works: existingWorks.length, folder: authorDir.name };
    }

    const info = await fetchAuthorInfo(uid, seed);
    const author = { ...seed, ...info.author, uid: info.author?.uid ?? uid };
    const finalName = `${clean(author.username || fallbackName, `UID${uid}`, 60)}_UID${uid}`;
    if (finalName !== tentativeName) authorDir = await state.archiveRoot.getDirectoryHandle(finalName, { create: true });
    scanLog(`获取作者 ${authorNumber}/${totalAuthors}：${author.username || uid}`);
    const rawWorks = await fetchAllAuthorWorks(uid, (page, count) => {
      scanLog(`${author.username || uid}：作品第 ${page} 页，累计 ${count} 条`);
    });
    const works = rawWorks.map(normalizeWork);
    await writeJson(authorDir, "author.raw.json", info.raw || author);
    await writeJson(authorDir, "author.json", {
      id: author.id || "",
      uid: author.uid ?? uid,
      username: author.username || fallbackName,
      signature: author.introduce || author.signature || "",
      videoCount: author.videoCnt ?? works.length,
      followerCount: author.followerCnt ?? null,
      likedCount: author.likedCnt ?? null,
      collectCount: author.collectCnt ?? null,
      avatarPath: author.avatarURL || "",
      backgroundPath: author.bgCoverUrl || "",
      scannedFromHomepageAt: new Date().toISOString()
    });
    await writeJson(authorDir, "works.raw.json", rawWorks);
    await writeJson(authorDir, "works.json", works);
    await writeFile(authorDir, "works.csv", csv(works));
    const exportState = await readJson(authorDir, "export-state.json", { completed: [], failed: {} }) || { completed: [], failed: {} };
    exportState.updatedAt = new Date().toISOString();
    exportState.uid = uid;
    exportState.author = author.username || fallbackName;
    await writeJson(authorDir, "export-state.json", exportState);

    const assets = await authorDir.getDirectoryHandle("assets", { create: true });
    if (saveCovers) {
      await saveImageIfMissing(assets, "avatar", author.avatarURL, 480).catch((error) => scanLog(`${author.username} 头像失败：${error.message}`));
      await saveImageIfMissing(assets, "background", author.bgCoverUrl, 1280).catch(() => {});
    }
    const worksDir = await authorDir.getDirectoryHandle("works", { create: true });
    const coverConcurrency = 4;
    for (let start = 0; start < works.length; start += coverConcurrency) {
      if (state.scannerCancelled) throw new DOMException("已取消", "AbortError");
      const batch = works.slice(start, start + coverConcurrency);
      await Promise.all(batch.map(async (work) => {
        const workDir = await worksDir.getDirectoryHandle(workFolderName(work), { create: true });
        if (!(await fileExists(workDir, "metadata.json"))) await writeJson(workDir, "metadata.json", work);
        if (!(await fileExists(workDir, "metadata.raw.json"))) await writeJson(workDir, "metadata.raw.json", rawWorks[work.index - 1] || work);
        if (saveCovers && work.coverPath) {
          await saveImageIfMissing(workDir, "cover", work.coverPath, 720).catch(async (error) => {
            await writeFile(workDir, "cover-error.txt", String(error.message || error));
          });
        }
      }));
      if (start % 40 === 0) scanLog(`${author.username || uid}：已保存 ${Math.min(start + batch.length, works.length)}/${works.length} 条作品元数据`);
    }
    return { status: "saved", uid, works: works.length, folder: authorDir.name };
  }

  async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const results = [];
    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (!state.scannerCancelled) {
        const index = cursor++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index], index); }
        catch (error) { results[index] = { status: "failed", error: error.message || String(error) }; }
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function startHomepageScan() {
    if (state.scannerRunning) return;
    if (!state.archiveRoot && !(await restoreArchiveRoot(true))) {
      if (!(await chooseArchiveRoot())) return;
    }
    const panel = scannerPanel();
    const pages = Math.max(1, Math.min(100, Number($("#archive-scan-pages", panel).value) || 20));
    const authorConcurrency = Math.max(1, Math.min(5, Number($("#archive-scan-author-concurrency", panel).value) || 2));
    const saveCovers = $("#archive-scan-covers", panel).checked;
    const reuseExisting = $("#archive-scan-reuse", panel).checked;
    state.scannerRunning = true;
    state.scannerCancelled = false;
    state.scanController = new AbortController();
    scanProgress(0);
    scanLog(`开始扫描首页前 ${pages} 页`);
    try {
      const category = $("#category-select")?.value || "";
      const authors = new Map();
      for (let page = 1; page <= pages; page += 1) {
        if (state.scannerCancelled) throw new DOMException("已取消", "AbortError");
        const response = await apiGet(cfg.videoCatalogPath || "videos/short", {
          page,
          pageSize: 20,
          categorieId: category,
          pid: cfg.pid || "PH"
        });
        const items = findArray(response.data);
        for (const item of items) {
          const video = videoOf(item);
          const author = video.user || item.user || {};
          const uid = String(author.uid ?? author.id ?? "");
          if (uid && !authors.has(uid)) authors.set(uid, author);
        }
        scanLog(`首页第 ${page}/${pages} 页：${items.length} 条视频，累计 ${authors.size} 个作者`);
        scanProgress((page / pages) * 25);
      }
      const list = [...authors.values()];
      scanLog(`首页扫描完成，共发现 ${list.length} 个作者；开始保存作者资料和全部作品`);
      let finished = 0;
      const results = await runPool(list, authorConcurrency, async (author, index) => {
        const result = await archiveOneAuthor(author, saveCovers, reuseExisting, index + 1, list.length);
        finished += 1;
        scanProgress(25 + (finished / Math.max(1, list.length)) * 75);
        scanLog(`作者完成 ${finished}/${list.length}：${author.username || author.uid} · ${result.status}`);
        return result;
      });
      const summary = results.reduce((acc, result) => {
        acc[result?.status || "failed"] = (acc[result?.status || "failed"] || 0) + 1;
        return acc;
      }, {});
      scanProgress(100);
      scanLog("首页作者批量归档完成", summary);
      await buildGlobalIndex();
      await applyDedupeToCurrent();
    } catch (error) {
      scanLog(state.scannerCancelled ? "扫描已取消" : `扫描失败：${error.message || error}`);
    } finally {
      state.scannerRunning = false;
      state.scanController = null;
    }
  }

  function openScanner() {
    const panel = scannerPanel();
    panel.hidden = false;
    updateScannerRootStatus();
  }

  function enhanceArchiveCenter() {
    const center = $("#archive-center");
    if (!center) return;
    const actions = $(".archive-center-header-actions", center);
    if (actions && !$("#archive-v2-root", actions)) {
      const rootButton = document.createElement("button");
      rootButton.id = "archive-v2-root";
      rootButton.type = "button";
      rootButton.textContent = "选择归档总目录";
      rootButton.onclick = async () => { if (await chooseArchiveRoot()) await applyDedupeToCurrent(); };
      actions.prepend(rootButton);
      const scanButton = document.createElement("button");
      scanButton.id = "archive-v2-scan";
      scanButton.type = "button";
      scanButton.textContent = "扫描首页作者";
      scanButton.onclick = openScanner;
      actions.prepend(scanButton);
    }
    const sidebar = $(".archive-center-sidebar", center);
    if (sidebar && !$("#archive-v2-dedupe-card", sidebar)) {
      const card = document.createElement("section");
      card.id = "archive-v2-dedupe-card";
      card.className = "archive-center-card archive-v2-dedupe-card";
      card.innerHTML = `<h3>跨作者去重</h3><p id="archive-v2-dedupe-status">尚未选择归档总目录</p><button type="button" id="archive-v2-rescan">重新扫描全部作者</button>`;
      $("#archive-v2-rescan", card).onclick = async () => {
        if (!state.archiveRoot && !(await restoreArchiveRoot(true))) return chooseArchiveRoot();
        await buildGlobalIndex();
        await applyDedupeToCurrent();
      };
      sidebar.insertBefore(card, sidebar.children[1] || null);
    }
    updateDedupeStatus();
  }

  function installTopButtons() {
    const topbar = $(".topbar");
    if (!topbar) return;
    if (!$("#archive-v2-home-scan")) {
      const button = document.createElement("button");
      button.id = "archive-v2-home-scan";
      button.type = "button";
      button.className = "archive-v2-top-button";
      button.textContent = "扫描首页作者";
      button.onclick = openScanner;
      topbar.append(button);
    }
  }

  function observeUi() {
    state.observer = new MutationObserver(() => {
      enhanceArchiveCenter();
      installTopButtons();
      decorateDuplicateCards();
      const folder = $("#archive-folder-status")?.textContent || "";
      if (folder && !/尚未选择|请选择/.test(folder)) {
        clearTimeout(observeUi.timer);
        observeUi.timer = setTimeout(() => applyDedupeToCurrent().catch((error) => log("自动去重失败", error.message, "warn")), 500);
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  async function boot() {
    scannerPanel();
    installTopButtons();
    enhanceArchiveCenter();
    observeUi();
    document.addEventListener("click", interceptPlay, true);
    await restoreArchiveRoot(false);
    await applyDedupeToCurrent().catch(() => {});
    window.ARCHIVE_V2 = {
      version: VERSION,
      chooseArchiveRoot,
      rebuildDedupeIndex: buildGlobalIndex,
      applyDedupe: applyDedupeToCurrent,
      openScanner,
      playById: async (id) => playSource(await sourceForItem(String(id))),
      get summary() {
        return {
          archiveRoot: state.archiveRoot?.name || "",
          indexedIds: state.globalById.size,
          duplicateItems: state.duplicates.size,
          scannerRunning: state.scannerRunning
        };
      }
    };
    log("预览分支 V2 扩展已加载", { version: VERSION });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
