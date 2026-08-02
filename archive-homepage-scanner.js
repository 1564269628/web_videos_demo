(() => {
  "use strict";

  const VERSION = "20260802-25-homepage-scan";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const DEFAULT_PAGES = 20;
  const DEFAULT_AUTHOR_CONCURRENCY = 2;

  const state = {
    root: null,
    scanning: false,
    cancelled: false,
    controller: null,
    authorNameFolders: new Map(),
    worksCache: new Map(),
    coverJobs: new Map(),
    taskObserver: null,
    taskScanTimer: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function log(message, details, level = "log") {
    console[level](`[HOMEPAGE SCANNER ${VERSION}] ${message}`, details ?? "");
    const output = $("#aad-log");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeJson(details)}`;
    output.textContent = `[${time}] [首页作者] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 160000);
  }

  function clean(value, fallback = "未命名", max = 80) {
    return (String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback).slice(0, max);
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}_]+/gu, "")
      .trim();
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

  async function getArchiveRoot(request = false) {
    if (state.root && await permission(state.root, request)) return state.root;
    try {
      const stored = await idbGet(ROOT_KEY);
      if (stored && await permission(stored, request)) {
        state.root = stored;
        return stored;
      }
    } catch (error) {
      log("读取已保存总目录失败", error.message || String(error), "warn");
    }

    if (!request) return null;
    if (typeof showDirectoryPicker !== "function") {
      throw new Error("当前浏览器不支持直接读写本地目录，请使用最新版 Edge 或 Chrome");
    }
    const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-all-authors-root" });
    if (!(await permission(handle, true))) throw new Error("没有所选目录的读写权限");
    state.root = handle;
    await idbSet(ROOT_KEY, handle);
    return handle;
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

  async function firstExistingFile(directory, names) {
    for (const name of names) {
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        if (file.size > 0) return { name, handle, file };
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  function b64ToBytes(value) {
    const binary = atob(String(value || "").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesToBase64(bytes) {
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

  async function fetchTimed(url, init = {}, timeoutMs = 22000, signal = state.controller?.signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason || "cancelled");
    if (signal) signal.aborted ? abort() : signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try { return await nativeFetch(url, { ...init, signal: controller.signal }); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
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

  function videoOf(value) {
    return value?.video && typeof value.video === "object" ? value.video : value || {};
  }

  function itemVideoId(value) {
    const video = videoOf(value);
    return String(video.id ?? video.videoId ?? video.vid ?? value?.id ?? "");
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
      signedPlaylistUrl: value?.url || work.url || work.signedPlaylistUrl || ""
    };
  }

  function csv(rows) {
    const keys = ["index", "id", "title", "description", "tags", "durationSeconds", "width", "height", "playCount", "likeCount", "commentCount", "collectCount", "releaseDate", "releaseDateLabel", "coverPath", "playPath", "signedPlaylistUrl"];
    const quote = (value) => `"${(Array.isArray(value) ? value.join("|") : String(value ?? "")).replace(/"/g, '""')}"`;
    return `\ufeff${keys.join(",")}\n${rows.map((row) => keys.map((key) => quote(row[key])).join(",")).join("\n")}\n`;
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
      if (state.cancelled) throw new DOMException("已取消", "AbortError");
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
      bytesToBase64(bytes),
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

  function resourceDomains() {
    let dynamic = [];
    try {
      const raw = JSON.parse($("#domain-json")?.textContent || "{}");
      const data = raw?.decoded?.data || raw?.decoded || raw?.data || raw;
      dynamic = data?.resDomains || data?.resourceDomains || data?.resourceUrls || [];
    } catch {
      dynamic = [];
    }
    return uniq([currentResource(), ...(Array.isArray(dynamic) ? dynamic : [dynamic])].map(normalizeBase));
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
        const response = await fetchTimed(candidate, { cache: "force-cache", credentials: "omit", mode: "cors" }, 18000, null);
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

  async function saveImageIfMissing(directory, baseName, path, size) {
    if (!path) return false;
    const existing = await firstExistingFile(directory, [`${baseName}.webp`, `${baseName}.jpg`, `${baseName}.jpeg`, `${baseName}.png`, `${baseName}.avif`]);
    if (existing) return false;
    const image = await getRemoteImage(path, size);
    await writeFile(directory, `${baseName}.${imageExtension(image.type)}`, image.bytes);
    return true;
  }

  async function archiveOneAuthor(seed, reuseExisting, authorNumber, totalAuthors) {
    const uid = String(seed.uid ?? seed.id ?? "");
    if (!uid) return { status: "skipped", reason: "缺少 UID" };
    const fallbackName = seed.username || `UID${uid}`;
    const tentativeName = `${clean(fallbackName, `UID${uid}`, 60)}_UID${uid}`;
    let authorDir = await state.root.getDirectoryHandle(tentativeName, { create: true });
    const existingAuthor = await readJson(authorDir, "author.json", null);
    const existingWorks = await readJson(authorDir, "works.json", null);
    if (reuseExisting && existingAuthor && Array.isArray(existingWorks)) {
      log(`复用已有作者 ${authorNumber}/${totalAuthors}：${existingAuthor.username || fallbackName}`, { works: existingWorks.length });
      return { status: "reused", uid, works: existingWorks.length, folder: authorDir.name };
    }

    const info = await fetchAuthorInfo(uid, seed);
    const author = { ...seed, ...info.author, uid: info.author?.uid ?? uid };
    const finalName = `${clean(author.username || fallbackName, `UID${uid}`, 60)}_UID${uid}`;
    if (finalName !== tentativeName) authorDir = await state.root.getDirectoryHandle(finalName, { create: true });
    updateScannerStatus(`正在获取作者 ${authorNumber}/${totalAuthors}：${author.username || uid}`);

    const rawWorks = await fetchAllAuthorWorks(uid, (page, count) => {
      updateScannerStatus(`${author.username || uid}：作品第 ${page} 页，累计 ${count} 条`);
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
    await authorDir.getDirectoryHandle("works", { create: true });

    const exportState = await readJson(authorDir, "export-state.json", { completed: [], failed: {} }) || { completed: [], failed: {} };
    exportState.updatedAt = new Date().toISOString();
    exportState.uid = uid;
    exportState.author = author.username || fallbackName;
    await writeJson(authorDir, "export-state.json", exportState);

    // 扫描阶段只保存作者头像，不创建作品目录，也不保存任何作品封面。
    if (author.avatarURL) {
      const assets = await authorDir.getDirectoryHandle("assets", { create: true });
      await saveImageIfMissing(assets, "avatar", author.avatarURL, 480)
        .catch((error) => log(`${author.username || uid} 作者头像保存失败`, error.message || String(error), "warn"));
    }

    log(`作者元数据保存完成 ${authorNumber}/${totalAuthors}：${author.username || uid}`, {
      works: works.length,
      workCoversSaved: 0
    });
    return { status: "saved", uid, works: works.length, folder: authorDir.name };
  }

  async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const results = [];
    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (!state.cancelled) {
        const index = cursor++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index], index); }
        catch (error) {
          results[index] = { status: "failed", error: error.message || String(error) };
          log(`作者任务失败 ${index + 1}/${items.length}`, error.message || String(error), "warn");
        }
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function scanHomepageAuthors() {
    if (state.scanning) return;
    try {
      state.root = await getArchiveRoot(true);
    } catch (error) {
      if (error.name !== "AbortError") alert(error.message || error);
      return;
    }

    const panel = ensureScannerUi();
    const pages = clamp($("#aad-home-pages", panel)?.value || DEFAULT_PAGES, 1, 100);
    const concurrency = clamp($("#aad-home-concurrency", panel)?.value || DEFAULT_AUTHOR_CONCURRENCY, 1, 5);
    const reuseExisting = $("#aad-home-reuse", panel)?.checked !== false;
    state.scanning = true;
    state.cancelled = false;
    state.controller = new AbortController();
    updateScannerControls();
    updateScannerProgress(0);
    updateScannerStatus(`开始扫描首页前 ${pages} 页；扫描阶段不会保存作品封面`);

    try {
      const category = $("#category-select")?.value || "";
      const authors = new Map();
      for (let page = 1; page <= pages; page += 1) {
        if (state.cancelled) throw new DOMException("已取消", "AbortError");
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
        updateScannerStatus(`首页第 ${page}/${pages} 页：${items.length} 条视频，累计 ${authors.size} 个作者`);
        updateScannerProgress((page / pages) * 25);
      }

      const list = [...authors.values()];
      updateScannerStatus(`首页扫描完成：发现 ${list.length} 个作者，开始保存作者资料和作品元数据`);
      let finished = 0;
      const results = await runPool(list, concurrency, async (author, index) => {
        const result = await archiveOneAuthor(author, reuseExisting, index + 1, list.length);
        finished += 1;
        updateScannerProgress(25 + (finished / Math.max(1, list.length)) * 75);
        updateScannerStatus(`作者完成 ${finished}/${list.length}：${author.username || author.uid} · ${result.status}`);
        return result;
      });

      const summary = results.reduce((output, result) => {
        const key = result?.status || "failed";
        output[key] = (output[key] || 0) + 1;
        return output;
      }, {});
      updateScannerProgress(100);
      updateScannerStatus(`首页作者扫描完成：${list.length} 个作者；作品封面保存 0 张`);
      log("首页作者批量元数据归档完成", summary);
      invalidateLocalCaches();
      await window.ALL_AUTHORS_ARCHIVE?.scan?.();
    } catch (error) {
      const cancelled = state.cancelled || error?.name === "AbortError";
      updateScannerStatus(cancelled ? "首页作者扫描已取消" : `扫描失败：${error.message || error}`);
      log(cancelled ? "首页作者扫描已取消" : "首页作者扫描失败", error.message || String(error), cancelled ? "warn" : "error");
    } finally {
      state.scanning = false;
      state.controller = null;
      updateScannerControls();
    }
  }

  function cancelHomepageScan() {
    if (!state.scanning) return;
    state.cancelled = true;
    state.controller?.abort("cancelled");
    updateScannerStatus("正在取消首页作者扫描…");
  }

  function workFolderName(work) {
    return `${String(work.index || 0).padStart(5, "0")}_${clean(work.title || work.id, work.id || "video", 56)}_${clean(work.id, "id", 32)}`;
  }

  function invalidateLocalCaches() {
    state.authorNameFolders.clear();
    state.worksCache.clear();
  }

  async function ensureAuthorNameIndex() {
    const root = await getArchiveRoot(false);
    if (!root || state.authorNameFolders.size) return;
    for await (const [folderName, directory] of root.entries()) {
      if (directory.kind !== "directory") continue;
      const author = await readJson(directory, "author.json", null);
      if (!author) continue;
      const keys = uniq([
        normalizedText(author.username),
        normalizedText(folderName.replace(/_UID\d+$/i, "")),
        normalizedText(folderName)
      ]);
      for (const key of keys) {
        if (!key) continue;
        const folders = state.authorNameFolders.get(key) || [];
        if (!folders.includes(folderName)) folders.push(folderName);
        state.authorNameFolders.set(key, folders);
      }
    }
  }

  async function loadFolderWorks(folderName) {
    if (state.worksCache.has(folderName)) return state.worksCache.get(folderName);
    const root = await getArchiveRoot(false);
    if (!root) return { directory: null, works: [] };
    try {
      const directory = await root.getDirectoryHandle(folderName);
      const raw = await readJson(directory, "works.json", []);
      const works = Array.isArray(raw) ? raw.map(normalizeWork) : [];
      const record = { directory, works };
      state.worksCache.set(folderName, record);
      return record;
    } catch {
      return { directory: null, works: [] };
    }
  }

  async function resolveWorkForTask(authorName, title) {
    await ensureAuthorNameIndex();
    const authorKey = normalizedText(authorName);
    const titleValue = normalizedText(title);
    const folders = state.authorNameFolders.get(authorKey) || [];
    for (const folderName of folders) {
      const record = await loadFolderWorks(folderName);
      const work = record.works.find((item) => normalizedText(item.title) === titleValue);
      if (work) return { folderName, authorDir: record.directory, work };
    }
    return null;
  }

  async function saveWorkCover(entry) {
    if (!entry?.authorDir || !entry.work?.coverPath) return false;
    const key = `${entry.folderName}::${entry.work.id || entry.work.index}`;
    if (state.coverJobs.has(key)) return state.coverJobs.get(key);

    const promise = (async () => {
      const worksDir = await entry.authorDir.getDirectoryHandle("works", { create: true });
      const workDir = await worksDir.getDirectoryHandle(workFolderName(entry.work), { create: true });
      const existing = await firstExistingFile(workDir, ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"]);
      if (existing) return false;
      const image = await getRemoteImage(entry.work.coverPath, 720);
      await writeFile(workDir, `cover.${imageExtension(image.type)}`, image.bytes);
      log("作品进入下载分片阶段，封面保存完成", {
        author: entry.folderName,
        id: entry.work.id,
        title: entry.work.title
      });
      return true;
    })().catch((error) => {
      log("下载时保存作品封面失败", {
        author: entry.folderName,
        id: entry.work.id,
        title: entry.work.title,
        error: error.message || String(error)
      }, "warn");
      return false;
    }).finally(() => {
      setTimeout(() => state.coverJobs.delete(key), 30000);
    });

    state.coverJobs.set(key, promise);
    return promise;
  }

  function scheduleActiveTaskScan() {
    clearTimeout(state.taskScanTimer);
    state.taskScanTimer = setTimeout(scanActiveDownloadTasks, 80);
  }

  async function scanActiveDownloadTasks() {
    for (const task of $$("#aad-tasks .aad-task")) {
      const phase = $("small", task)?.textContent || "";
      if (!phase.includes("下载分片")) continue;
      const authorName = $("strong", task)?.textContent?.trim() || "";
      const title = $("span", task)?.textContent?.trim() || "";
      if (!authorName || !title) continue;
      const marker = `${normalizedText(authorName)}::${normalizedText(title)}`;
      if (task.dataset.coverScheduled === marker) continue;
      task.dataset.coverScheduled = marker;
      const entry = await resolveWorkForTask(authorName, title);
      if (entry) saveWorkCover(entry);
      else log("下载任务已开始，但没有在本地元数据中定位到封面", { authorName, title }, "warn");
    }
  }

  function injectStyles() {
    if ($("#aad-homepage-scanner-styles")) return;
    const style = document.createElement("style");
    style.id = "aad-homepage-scanner-styles";
    style.textContent = `
      .aad-home-scan-card{border-color:rgba(91,208,190,.3)!important}
      .aad-home-scan-card h3{margin-bottom:8px}
      .aad-home-scan-card p{margin:0 0 10px;color:var(--muted,#aab4ce);font-size:12px;line-height:1.55}
      .aad-home-scan-card label{display:grid;grid-template-columns:1fr 86px;gap:10px;align-items:center;margin:8px 0;color:var(--muted,#aab4ce);font-size:12px}
      .aad-home-scan-card input[type=number]{width:100%;padding:7px 8px;border:1px solid rgba(125,140,255,.28);border-radius:8px;color:inherit;background:rgba(8,13,26,.86)}
      .aad-home-scan-card .aad-check{display:flex;grid-template-columns:none;align-items:flex-start;gap:8px}
      .aad-home-scan-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      .aad-home-progress{height:6px;overflow:hidden;margin:10px 0 8px;border-radius:999px;background:rgba(255,255,255,.08)}
      .aad-home-progress span{display:block;width:0;height:100%;background:linear-gradient(90deg,#7184ff,#55d6be);transition:width .18s ease}
      #aad-home-status{overflow-wrap:anywhere}
    `;
    document.head.append(style);
  }

  function ensureScannerUi() {
    injectStyles();
    const panel = $("#all-authors-center");
    if (!panel) return null;
    const sidebar = $(".aad-sidebar", panel);
    if (!sidebar) return panel;

    let card = $("#aad-home-scan-card", panel);
    if (!card) {
      card = document.createElement("section");
      card.id = "aad-home-scan-card";
      card.className = "aad-card aad-home-scan-card";
      card.innerHTML = `
        <h3>扫描首页作者</h3>
        <p>从服务器首页前 N 页收集作者，保存作者资料和全部作品元数据。扫描阶段不保存作品封面；封面只在视频真正进入“下载分片”阶段时保存。</p>
        <label>首页页数 <input id="aad-home-pages" type="number" min="1" max="100" value="${DEFAULT_PAGES}"></label>
        <label>作者并发 <input id="aad-home-concurrency" type="number" min="1" max="5" value="${DEFAULT_AUTHOR_CONCURRENCY}"></label>
        <label class="aad-check"><input id="aad-home-reuse" type="checkbox" checked> 已有 author.json 和 works.json 时直接复用</label>
        <div class="aad-home-scan-actions">
          <button type="button" id="aad-home-start">扫描首页作者</button>
          <button type="button" id="aad-home-cancel" class="ghost-button" disabled>取消扫描</button>
        </div>
        <div class="aad-home-progress"><span></span></div>
        <p id="aad-home-status">等待开始</p>`;
      const downloadCard = sidebar.firstElementChild;
      downloadCard?.insertAdjacentElement("afterend", card);
      $("#aad-home-start", card).onclick = scanHomepageAuthors;
      $("#aad-home-cancel", card).onclick = cancelHomepageScan;
    }

    const actions = $(".aad-header-actions", panel);
    if (actions && !$("#aad-home-header-button", actions)) {
      const button = document.createElement("button");
      button.id = "aad-home-header-button";
      button.type = "button";
      button.textContent = "扫描首页作者";
      button.onclick = scanHomepageAuthors;
      actions.prepend(button);
    }
    updateScannerControls();
    return panel;
  }

  function updateScannerStatus(message) {
    const status = $("#aad-home-status");
    if (status) status.textContent = message;
    const main = $("#aad-scan-status");
    if (main && state.scanning) main.textContent = message;
  }

  function updateScannerProgress(percent) {
    const bar = $(".aad-home-progress span");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  }

  function updateScannerControls() {
    const start = $("#aad-home-start");
    const cancel = $("#aad-home-cancel");
    const header = $("#aad-home-header-button");
    if (start) start.disabled = state.scanning;
    if (cancel) cancel.disabled = !state.scanning;
    if (header) header.disabled = state.scanning;
  }

  function installTaskWatcher() {
    const tasks = $("#aad-tasks");
    if (!tasks || state.taskObserver) return;
    state.taskObserver = new MutationObserver(scheduleActiveTaskScan);
    state.taskObserver.observe(tasks, { childList: true, subtree: true, characterData: true });
    scheduleActiveTaskScan();
  }

  function install() {
    ensureScannerUi();
    installTaskWatcher();
  }

  function boot() {
    install();
    const observer = new MutationObserver(install);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    getArchiveRoot(false).then((root) => {
      if (root) {
        state.root = root;
        log("已连接全部作者归档总目录", { root: root.name });
      }
    });
    window.HOMEPAGE_AUTHOR_SCANNER = {
      version: VERSION,
      start: scanHomepageAuthors,
      cancel: cancelHomepageScan,
      saveCoverForActiveTasks: scanActiveDownloadTasks,
      get scanning() { return state.scanning; }
    };
    log("首页作者扫描功能已加载；作品封面仅在下载分片阶段保存");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
