(() => {
  "use strict";

  const VERSION = "20260802-24-all-authors";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const PAGE_SIZE = 60;

  const DEFAULT_SETTINGS = {
    maxSegments: 50,
    videoConcurrency: 4,
    segmentConcurrency: 8,
    smallOnly: true
  };

  const state = {
    root: null,
    authors: [],
    items: [],
    itemByKey: new Map(),
    settings: loadSettings(),
    filter: "all",
    search: "",
    page: 1,
    queue: [],
    queued: new Set(),
    active: new Map(),
    running: false,
    paused: false,
    controller: null,
    scanning: false,
    coverUrls: new Map(),
    playerUrls: [],
    playerHls: null,
    rootWrite: Promise.resolve()
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function log(message, details, level = "log") {
    console[level](`[ALL AUTHORS ${VERSION}] ${message}`, details ?? "");
    const output = $("#aad-log");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeJson(details)}`;
    output.textContent = `[${time}] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 120000);
  }

  function clean(value, fallback = "未命名", max = 80) {
    return (String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback).slice(0, max);
  }

  function normalizeTitle(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}_]+/gu, "")
      .trim();
  }

  function titleKey(item) {
    const title = normalizeTitle(item.title);
    const duration = Math.max(0, Math.round(Number(item.durationSeconds || 0)));
    return title ? `${title}::${duration}` : "";
  }

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("hq-all-authors-settings") || "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    localStorage.setItem("hq-all-authors-settings", JSON.stringify(state.settings));
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

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Math.floor(Number(value || 0)));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function formatSpeed(value) {
    return `${formatBytes(value)}/s`;
  }

  function statusText(status) {
    return ({
      downloaded: "已下载",
      duplicate: "跨作者重复",
      queued: "队列中",
      analyzing: "分析中",
      downloading: "下载中",
      deferred: "超过分片上限",
      failed: "失败",
      partial: "未完成",
      pending: "未下载"
    })[status] || status || "未下载";
  }

  function itemKey(authorFolder, id, index) {
    return `${authorFolder}::${id || `index-${index}`}`;
  }

  function workFolderName(item) {
    return `${String(item.index || 0).padStart(5, "0")}_${clean(item.title || item.id, item.id || "video", 56)}_${clean(item.id, "id", 32)}`;
  }

  function videoOf(value) {
    return value?.video && typeof value.video === "object" ? value.video : value || {};
  }

  function normalizeWork(value, index, authorRecord) {
    const work = videoOf(value);
    const tags = Array.isArray(work.videoTags)
      ? work.videoTags
      : Array.isArray(work.tags)
        ? work.tags.map((tag) => typeof tag === "string" ? tag : tag?.name).filter(Boolean)
        : [];
    const id = String(work.id ?? work.videoId ?? work.vid ?? value?.id ?? "");
    return {
      key: itemKey(authorRecord.folderName, id, index + 1),
      author: authorRecord,
      index: Number(value?.index || work.index || index + 1),
      id,
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
      coverPath: work.coverPath || work.verticalCoverURL || work.coverURL || "",
      playPath: work.playPath || work.playURL || work.playUrl || "",
      signedPlaylistUrl: value?.url || work.url || work.signedPlaylistUrl || "",
      folderName: "",
      workDir: null,
      videoFile: "",
      videoHandle: null,
      coverHandle: null,
      byteLength: 0,
      segmentCount: null,
      playlistUrl: "",
      completedAt: "",
      error: "",
      status: "pending",
      duplicateOf: null
    };
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

  async function listDirectories(directory) {
    const output = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "directory") output.push([name, handle]);
    }
    return output;
  }

  async function resolveLocalFiles(authorRecord, item, indexEntry, directoryNames) {
    const expected = indexEntry.folderName || workFolderName(item);
    const idSuffix = item.id ? `_${clean(item.id, "id", 32)}` : "";
    const prefix = `${String(item.index || 0).padStart(5, "0")}_`;
    const folderName = directoryNames.includes(expected)
      ? expected
      : directoryNames.find((name) => (idSuffix && name.endsWith(idSuffix)) || name.startsWith(prefix)) || expected;

    item.folderName = folderName;
    try {
      const workDir = await authorRecord.worksDir.getDirectoryHandle(folderName);
      item.workDir = workDir;
      const video = await firstExistingFile(workDir, [indexEntry.videoFile, "video.mp4", "video.ts"].filter(Boolean));
      const download = await readJson(workDir, "download.json", null);
      if (video) {
        item.videoFile = video.name;
        item.videoHandle = video.handle;
        item.byteLength = video.file.size;
        item.status = download || indexEntry.status === "downloaded" ? "downloaded" : "partial";
      }
      const cover = await firstExistingFile(workDir, ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"]);
      if (cover) item.coverHandle = cover.handle;
      if (download) {
        item.segmentCount = Number.isFinite(Number(download.segmentCount)) ? Number(download.segmentCount) : item.segmentCount;
        item.playlistUrl = download.playlistUrl || "";
        item.completedAt = download.completedAt || "";
        item.byteLength = Number(download.byteLength || item.byteLength || 0);
      }
    } catch {
      item.workDir = null;
    }

    if (item.status !== "downloaded") {
      item.status = indexEntry.status === "failed"
        ? "failed"
        : indexEntry.status === "deferred"
          ? "deferred"
          : indexEntry.status === "partial"
            ? "partial"
            : "pending";
    }
    const rawSegments = indexEntry.segmentCount;
    if (rawSegments !== null && rawSegments !== undefined && Number.isFinite(Number(rawSegments))) {
      item.segmentCount = Number(rawSegments);
    }
    item.error = indexEntry.error || "";
    item.playlistUrl ||= indexEntry.playlistUrl || "";
    item.completedAt ||= indexEntry.completedAt || "";
  }

  async function scanAuthorFolder(folderName, directory) {
    const authorJson = await readJson(directory, "author.json", null);
    const worksRaw = await readJson(directory, "works.json", null);
    if (!authorJson || !Array.isArray(worksRaw)) return null;

    const authorRecord = {
      folderName,
      directory,
      worksDir: await directory.getDirectoryHandle("works", { create: true }),
      author: authorJson,
      index: await readJson(directory, "archive-index.json", { items: {} }) || { items: {} },
      indexWrite: Promise.resolve(),
      items: [],
      stats: {}
    };
    authorRecord.index.items ||= {};

    const directoryNames = (await listDirectories(authorRecord.worksDir)).map(([name]) => name);
    const works = worksRaw.map((value, index) => normalizeWork(value, index, authorRecord));
    for (let index = 0; index < works.length; index += 1) {
      const item = works[index];
      const entry = authorRecord.index.items[item.id] || {};
      await resolveLocalFiles(authorRecord, item, entry, directoryNames);
      if (index > 0 && index % 250 === 0) updateScanMessage(`正在读取 ${folderName}：${index}/${works.length}`);
    }
    authorRecord.items = works;
    updateAuthorStats(authorRecord);
    return authorRecord;
  }

  function applyCrossAuthorDedupe() {
    const byId = new Map();
    const byTitle = new Map();
    const ordered = [...state.items].sort((left, right) => {
      const leftDownloaded = left.status === "downloaded" ? 0 : 1;
      const rightDownloaded = right.status === "downloaded" ? 0 : 1;
      return leftDownloaded - rightDownloaded || left.author.folderName.localeCompare(right.author.folderName) || left.index - right.index;
    });

    for (const item of ordered) {
      item.duplicateOf = null;
      let source = null;
      if (item.id) {
        const hit = byId.get(item.id);
        if (hit && hit.author.folderName !== item.author.folderName) source = hit;
      }
      const key = titleKey(item);
      if (!source && key) {
        const hit = byTitle.get(key);
        if (hit && hit.author.folderName !== item.author.folderName) source = hit;
      }
      if (source) {
        item.duplicateOf = source;
        if (source.status === "downloaded") item.status = "duplicate";
      } else {
        if (item.id && !byId.has(item.id)) byId.set(item.id, item);
        if (key && !byTitle.has(key)) byTitle.set(key, item);
      }
    }
  }

  function updateAuthorStats(authorRecord) {
    const stats = { total: authorRecord.items.length, downloaded: 0, duplicate: 0, pending: 0, failed: 0, deferred: 0, bytes: 0 };
    for (const item of authorRecord.items) {
      if (item.status === "downloaded") {
        stats.downloaded += 1;
        stats.bytes += Number(item.byteLength || 0);
      } else if (item.status === "duplicate") stats.duplicate += 1;
      else if (item.status === "failed") stats.failed += 1;
      else if (item.status === "deferred") stats.deferred += 1;
      else stats.pending += 1;
    }
    authorRecord.stats = stats;
  }

  function updateAllAuthorStats() {
    for (const author of state.authors) updateAuthorStats(author);
  }

  async function chooseRoot() {
    if (typeof showDirectoryPicker !== "function") {
      alert("请使用最新版 Edge 或 Chrome。当前浏览器不支持直接读写本地文件夹。");
      return false;
    }
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-all-authors-root" });
      if (!(await permission(handle, true))) throw new Error("没有所选目录的读写权限");
      state.root = handle;
      await idbSet(ROOT_KEY, handle);
      await scanRoot();
      return true;
    } catch (error) {
      if (error.name !== "AbortError") {
        log("选择归档总目录失败", error.message || String(error), "error");
        alert(error.message || error);
      }
      return false;
    }
  }

  async function restoreRoot(request = false) {
    try {
      const handle = await idbGet(ROOT_KEY);
      if (!handle || !(await permission(handle, request))) return false;
      state.root = handle;
      return true;
    } catch (error) {
      log("恢复归档总目录失败", error.message || String(error), "warn");
      return false;
    }
  }

  function updateScanMessage(message) {
    const element = $("#aad-scan-status");
    if (element) element.textContent = message;
  }

  async function scanRoot() {
    if (!state.root || state.scanning) return;
    state.scanning = true;
    stopQueue(true);
    revokeCoverUrls();
    state.authors = [];
    state.items = [];
    state.itemByKey.clear();
    state.page = 1;
    renderAll();
    updateScanMessage(`正在扫描 ${state.root.name}…`);

    try {
      let folders = 0;
      for await (const [folderName, handle] of state.root.entries()) {
        if (handle.kind !== "directory") continue;
        folders += 1;
        updateScanMessage(`正在检查第 ${folders} 个文件夹：${folderName}`);
        const author = await scanAuthorFolder(folderName, handle).catch((error) => {
          log(`跳过目录 ${folderName}`, error.message || String(error), "warn");
          return null;
        });
        if (!author) continue;
        state.authors.push(author);
        for (const item of author.items) {
          state.items.push(item);
          state.itemByKey.set(item.key, item);
        }
        renderSummary();
      }

      applyCrossAuthorDedupe();
      updateAllAuthorStats();
      updateScanMessage(`扫描完成：${state.authors.length} 个作者、${state.items.length} 条作品`);
      log("全部作者目录扫描完成", {
        root: state.root.name,
        authors: state.authors.length,
        works: state.items.length,
        downloaded: state.items.filter((item) => item.status === "downloaded").length,
        duplicate: state.items.filter((item) => item.status === "duplicate").length
      });
      renderAll();
    } finally {
      state.scanning = false;
    }
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

  async function fetchTimed(url, init = {}, timeoutMs = 22000, parentSignal = state.controller?.signal) {
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
    if (!api) throw new Error("网页 API 尚未连接，无法刷新视频地址");
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

  function extractPlayable(payload) {
    const data = payload?.data || payload || {};
    const value = data.video || data;
    return data.url || value.url || value.playURL || value.playUrl || value.m3u8URL || value.m3u8Url || "";
  }

  async function freshPlayable(item) {
    const paths = uniq([
      String(cfg.videoDetailPath || "videos/{id}").replace("{id}", encodeURIComponent(item.id)),
      `videos/${encodeURIComponent(item.id)}`,
      `shortVideos/${encodeURIComponent(item.id)}`,
      `newsVideos/${encodeURIComponent(item.id)}`
    ]);
    let lastError;
    for (const path of paths) {
      try {
        const response = await apiGet(path, { pid: cfg.pid || "PH" });
        const url = extractPlayable(response);
        if (url) return url;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("服务器没有返回新的播放地址");
  }

  function playbackUrl(value) {
    const url = new URL(value);
    if (cfg.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", cfg.pid);
    if (currentResource() && !url.searchParams.has("domain")) url.searchParams.set("domain", currentResource());
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.href;
  }

  function parseAttributes(value) {
    const result = {};
    String(value || "").replace(/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi, (all, key, raw) => {
      result[key.toUpperCase()] = String(raw || "").replace(/^"|"$/g, "");
      return all;
    });
    return result;
  }

  async function playlistText(url) {
    const response = await fetchTimed(playbackUrl(url), {
      headers: { m: "1" },
      cache: "no-store",
      credentials: "omit",
      mode: "cors"
    });
    if (!response.ok) throw new Error(`m3u8 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      const inflated = pako.inflate(bytes, { to: "string" });
      if (inflated.includes("#EXTM3U")) return inflated;
    } catch {
      // Plain playlist fallback.
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error(`服务器没有返回有效 m3u8：${text.slice(0, 120).replace(/\s+/g, " ")}`);
    return text;
  }

  async function resolvePlaylist(url) {
    let current = playbackUrl(url);
    for (let depth = 0; depth < 4; depth += 1) {
      const text = await playlistText(current);
      const lines = text.split(/\r?\n/);
      const variants = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
        const attrs = parseAttributes(lines[index].slice(lines[index].indexOf(":") + 1));
        let next = index + 1;
        while (next < lines.length && (!lines[next].trim() || lines[next].startsWith("#"))) next += 1;
        if (next < lines.length) variants.push({ bandwidth: Number(attrs.BANDWIDTH || 0), url: new URL(lines[next].trim(), current).href });
      }
      variants.sort((left, right) => right.bandwidth - left.bandwidth);
      if (!variants.length) return { url: current, text };
      current = variants[0].url;
    }
    throw new Error("播放列表嵌套过深");
  }

  function parseMedia(text, sourceUrl) {
    const segments = [];
    let sequence = 0;
    let key = null;
    let init = "";
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(line.split(":")[1] || 0);
      else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
        key = { method: attrs.METHOD || "NONE", iv: attrs.IV || "" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
        if (attrs.URI) init = new URL(attrs.URI, sourceUrl).href;
      } else if (!line.startsWith("#")) {
        segments.push({ url: new URL(line, sourceUrl).href, sequence, key: key ? { ...key } : null });
        sequence += 1;
      }
    }
    return { segments, init };
  }

  async function preparePlaylist(item, forceFresh = false) {
    const candidates = forceFresh ? [] : [item.signedPlaylistUrl, item.playPath, item.playlistUrl];
    let lastError;
    for (const candidate of uniq(candidates)) {
      try {
        const resolved = await resolvePlaylist(candidate);
        return { ...resolved, parsed: parseMedia(resolved.text, resolved.url), source: "local-metadata" };
      } catch (error) {
        lastError = error;
      }
    }
    const fresh = await freshPlayable(item);
    try {
      const resolved = await resolvePlaylist(fresh);
      return { ...resolved, parsed: parseMedia(resolved.text, resolved.url), source: "fresh-api" };
    } catch (error) {
      throw new Error(`旧播放地址不可用，刷新地址后仍失败：${error.message || lastError?.message || error}`);
    }
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

  function normalizedMediaUrl(value, origin) {
    const original = new URL(value);
    const base = new URL(origin);
    base.pathname = original.pathname.replace(/\/{2,}/g, "/");
    base.search = original.search;
    base.hash = "";
    return base.href;
  }

  function mediaCandidates(value, task) {
    const candidates = [];
    try {
      const original = new URL(value);
      candidates.push(original.href.replace(/([^:]\/)\/{2,}/g, "$1"));
      for (const domain of uniq([task?.preferredOrigin, ...resourceDomains()])) {
        const origin = new URL(domain).origin;
        if (task?.disabledOrigins?.has(origin)) continue;
        candidates.push(normalizedMediaUrl(original.href, domain));
      }
    } catch {
      candidates.push(value);
    }
    return uniq(candidates);
  }

  function inspectResponse(response, bytes) {
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2048))).trim();
    if (!bytes.length) return "响应为空";
    if (type.includes("text/html") || /^<!doctype html|^<html|<h1>\s*404\s*<\/h1>/i.test(sample)) return `服务器返回 HTML：${sample.slice(0, 100)}`;
    if (!response.ok) return `HTTP ${response.status}`;
    return "";
  }

  async function mediaBytes(url, task) {
    const errors = [];
    for (const candidate of mediaCandidates(url, task)) {
      const origin = (() => { try { return new URL(candidate).origin; } catch { return ""; } })();
      try {
        const response = await fetchTimed(candidate, { cache: "no-store", credentials: "omit", mode: "cors" }, 30000);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const problem = inspectResponse(response, bytes);
        if (problem) {
          errors.push(`${origin || candidate}: ${problem}`);
          continue;
        }
        if (origin) task.preferredOrigin = origin;
        return bytes;
      } catch (error) {
        errors.push(`${origin || candidate}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join("；") || "所有资源线路均失败");
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

  async function decryptSegment(bytes, keyInfo, sequence) {
    if (!keyInfo || String(keyInfo.method || "NONE").toUpperCase() === "NONE") return bytes;
    if (String(keyInfo.method).toUpperCase() !== "AES-128") throw new Error(`暂不支持 ${keyInfo.method} 分片加密`);
    const keyBytes = b64ToBytes(cfg.mediaKeyBase64);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: parseIv(keyInfo.iv, sequence) }, cryptoKey, bytes);
    return new Uint8Array(decrypted);
  }

  async function ensureWorkDirectory(item) {
    const directory = await item.author.worksDir.getDirectoryHandle(item.folderName || workFolderName(item), { create: true });
    item.folderName = directory.name;
    item.workDir = directory;
    const metadata = await firstExistingFile(directory, ["metadata.json"]);
    if (!metadata) await writeJson(directory, "metadata.json", {
      index: item.index,
      id: item.id,
      title: item.title,
      description: item.description,
      tags: item.tags,
      durationSeconds: item.durationSeconds,
      width: item.width,
      height: item.height,
      playCount: item.playCount,
      likeCount: item.likeCount,
      commentCount: item.commentCount,
      collectCount: item.collectCount,
      releaseDate: item.releaseDate,
      coverPath: item.coverPath,
      playPath: item.playPath,
      signedPlaylistUrl: item.signedPlaylistUrl
    });
    return directory;
  }

  function updateTaskProgress(task, done, total, bytes) {
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - task.speedAt) / 1000);
    if (elapsed >= 0.5) {
      task.speed = Math.max(0, bytes - task.speedBytes) / elapsed;
      task.speedAt = now;
      task.speedBytes = bytes;
    }
    task.doneSegments = done;
    task.totalSegments = total;
    task.bytes = bytes;
    renderTasks();
    renderSummary();
  }

  async function downloadPrepared(item, prepared, task) {
    const directory = await ensureWorkDirectory(item);
    await writeFile(directory, "playlist.m3u8", prepared.text);
    const parsed = prepared.parsed;
    const fileName = parsed.init ? "video.mp4" : "video.ts";
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    let bytesWritten = 0;

    try {
      if (parsed.init) {
        const initBytes = await mediaBytes(parsed.init, task);
        await writable.write(initBytes);
        bytesWritten += initBytes.length;
      }
      const concurrency = clamp(state.settings.segmentConcurrency, 1, 16);
      for (let start = 0; start < parsed.segments.length; start += concurrency) {
        if (state.controller?.signal.aborted) throw new DOMException("已暂停", "AbortError");
        const batch = parsed.segments.slice(start, start + concurrency);
        const chunks = await Promise.all(batch.map(async (segment) => {
          const bytes = await mediaBytes(segment.url, task);
          return decryptSegment(bytes, segment.key, segment.sequence);
        }));
        for (const chunk of chunks) {
          await writable.write(chunk);
          bytesWritten += chunk.length;
        }
        updateTaskProgress(task, Math.min(parsed.segments.length, start + batch.length), parsed.segments.length, bytesWritten);
      }
    } finally {
      await writable.close();
    }

    const download = {
      fileName,
      byteLength: bytesWritten,
      segmentCount: parsed.segments.length,
      playlistUrl: prepared.url,
      source: prepared.source,
      completedAt: new Date().toISOString()
    };
    await writeJson(directory, "download.json", download);
    item.videoHandle = fileHandle;
    item.videoFile = fileName;
    return download;
  }

  async function saveAuthorIndex(authorRecord) {
    authorRecord.index.version = VERSION;
    authorRecord.index.updatedAt = new Date().toISOString();
    authorRecord.index.settings = { ...state.settings };
    authorRecord.index.items ||= {};
    for (const item of authorRecord.items) {
      authorRecord.index.items[item.id] = {
        folderName: item.folderName || workFolderName(item),
        status: item.status === "analyzing" || item.status === "downloading" || item.status === "queued" ? "partial" : item.status,
        segmentCount: Number.isFinite(item.segmentCount) ? item.segmentCount : null,
        videoFile: item.videoFile || "",
        byteLength: Number(item.byteLength || 0),
        completedAt: item.completedAt || "",
        error: item.error || "",
        lastAttemptAt: item.lastAttemptAt || "",
        playlistUrl: item.playlistUrl || ""
      };
    }
    authorRecord.indexWrite = authorRecord.indexWrite
      .catch(() => {})
      .then(() => writeJson(authorRecord.directory, "archive-index.json", authorRecord.index));
    return authorRecord.indexWrite;
  }

  async function markDuplicateReferences(source) {
    for (const item of state.items) {
      if (item.duplicateOf !== source) continue;
      item.status = "duplicate";
      item.error = `复用 ${source.author.folderName} / ${source.folderName}`;
      const directory = await ensureWorkDirectory(item);
      await writeJson(directory, "duplicate.json", {
        version: VERSION,
        detectedAt: new Date().toISOString(),
        sourceAuthorFolder: source.author.folderName,
        sourceWorkFolder: source.folderName,
        sourceVideoFile: source.videoFile,
        sourceVideoId: source.id,
        reason: item.id && item.id === source.id ? "视频 ID 相同" : "规范化标题和时长相同"
      });
      await saveAuthorIndex(item.author);
    }
  }

  async function processItem(item) {
    const task = {
      item,
      phase: "分析播放列表",
      totalSegments: item.segmentCount || 0,
      doneSegments: 0,
      bytes: 0,
      speed: 0,
      speedAt: performance.now(),
      speedBytes: 0,
      preferredOrigin: "",
      disabledOrigins: new Set()
    };
    state.active.set(item.key, task);
    item.status = "analyzing";
    item.error = "";
    item.lastAttemptAt = new Date().toISOString();
    renderAll();

    try {
      let prepared;
      try { prepared = await preparePlaylist(item, false); }
      catch { prepared = await preparePlaylist(item, true); }
      item.segmentCount = prepared.parsed.segments.length;
      item.playlistUrl = prepared.url;
      task.totalSegments = item.segmentCount;
      renderTasks();

      if (state.settings.smallOnly && item.segmentCount > state.settings.maxSegments) {
        item.status = "deferred";
        item.error = `分片 ${item.segmentCount}，超过上限 ${state.settings.maxSegments}`;
        return;
      }

      item.status = "downloading";
      task.phase = "下载分片";
      renderAll();
      const result = await downloadPrepared(item, prepared, task);
      item.status = "downloaded";
      item.videoFile = result.fileName;
      item.byteLength = result.byteLength;
      item.segmentCount = result.segmentCount;
      item.completedAt = result.completedAt;
      item.playlistUrl = result.playlistUrl;
      item.error = "";
      await markDuplicateReferences(item);
      log("视频下载完成", {
        author: item.author.folderName,
        id: item.id,
        title: item.title,
        segments: result.segmentCount,
        size: formatBytes(result.byteLength)
      });
    } catch (error) {
      if (error?.name === "AbortError" || state.paused) {
        item.status = "partial";
        item.error = "下载已暂停";
      } else {
        item.status = "failed";
        item.error = error.message || String(error);
        log("视频任务失败", { author: item.author.folderName, id: item.id, title: item.title, error: item.error }, "warn");
      }
    } finally {
      state.active.delete(item.key);
      await saveAuthorIndex(item.author);
      updateAllAuthorStats();
      renderAll();
    }
  }

  function canonicalItems() {
    return state.items.filter((item) => !item.duplicateOf);
  }

  function sortQueue() {
    state.queue.sort((leftKey, rightKey) => {
      const left = state.itemByKey.get(leftKey);
      const right = state.itemByKey.get(rightKey);
      const leftKnown = Number.isFinite(left?.segmentCount);
      const rightKnown = Number.isFinite(right?.segmentCount);
      if (leftKnown && rightKnown) return left.segmentCount - right.segmentCount || left.durationSeconds - right.durationSeconds;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return left.durationSeconds - right.durationSeconds;
    });
  }

  function enqueueAll() {
    if (!state.root) return chooseRoot();
    for (const item of canonicalItems()) {
      if (["downloaded", "queued", "analyzing", "downloading"].includes(item.status)) continue;
      if (state.active.has(item.key) || state.queued.has(item.key)) continue;
      item.status = "queued";
      item.error = "";
      state.queued.add(item.key);
      state.queue.push(item.key);
    }
    sortQueue();
    renderAll();
    startQueue();
  }

  async function workerLoop(workerIndex) {
    while (state.running && !state.paused) {
      const key = state.queue.shift();
      if (!key) return;
      state.queued.delete(key);
      const item = state.itemByKey.get(key);
      if (!item || item.status === "downloaded" || item.duplicateOf) continue;
      await processItem(item);
      await sleep(workerIndex * 25);
    }
  }

  async function startQueue() {
    if (state.running && !state.paused) return;
    if (!state.queue.length) return;
    state.running = true;
    state.paused = false;
    state.controller = new AbortController();
    renderAll();
    const workers = Array.from({ length: clamp(state.settings.videoConcurrency, 1, 8) }, (_, index) => workerLoop(index + 1));
    await Promise.allSettled(workers);
    state.running = false;
    state.controller = null;
    renderAll();
  }

  function stopQueue(silent = false) {
    if (!state.running && !state.active.size) return;
    state.paused = true;
    state.running = false;
    state.controller?.abort("paused");
    if (!silent) log("下载队列已暂停");
    renderAll();
  }

  function resumeQueue() {
    for (const item of canonicalItems()) {
      if (item.status !== "partial") continue;
      if (state.queued.has(item.key)) continue;
      item.status = "queued";
      state.queued.add(item.key);
      state.queue.push(item.key);
    }
    sortQueue();
    startQueue();
  }

  function clearQueue() {
    stopQueue(true);
    for (const key of state.queue) {
      const item = state.itemByKey.get(key);
      if (item?.status === "queued") item.status = "pending";
    }
    state.queue = [];
    state.queued.clear();
    renderAll();
  }

  function filteredItems() {
    const query = state.search.trim().toLowerCase();
    return state.items.filter((item) => {
      const matchesStatus = state.filter === "all" || item.status === state.filter;
      if (!matchesStatus) return false;
      if (!query) return true;
      return [item.title, item.id, item.author.folderName, item.author.author?.username, ...(item.tags || [])]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }

  function summary() {
    const result = { authors: state.authors.length, total: state.items.length, downloaded: 0, duplicate: 0, pending: 0, failed: 0, deferred: 0, active: state.active.size, queued: state.queue.length, bytes: 0 };
    for (const item of state.items) {
      if (item.status === "downloaded") {
        result.downloaded += 1;
        result.bytes += Number(item.byteLength || 0);
      } else if (item.status === "duplicate") result.duplicate += 1;
      else if (item.status === "failed") result.failed += 1;
      else if (item.status === "deferred") result.deferred += 1;
      else result.pending += 1;
    }
    return result;
  }

  function ensureUi() {
    let panel = $("#all-authors-center");
    if (panel) return panel;

    panel = document.createElement("section");
    panel.id = "all-authors-center";
    panel.className = "aad-shell";
    panel.innerHTML = `
      <header class="aad-header">
        <div>
          <p class="aad-eyebrow">LOCAL ARCHIVE · ALL AUTHORS ONLY</p>
          <h2>全部作者归档中心</h2>
          <p id="aad-scan-status">请选择归档总目录，例如 F:\\tools\\short_videos</p>
        </div>
        <div class="aad-header-actions">
          <button type="button" id="aad-choose-root">选择总目录</button>
          <button type="button" id="aad-rescan" class="ghost-button">重新扫描</button>
          <button type="button" id="aad-close" class="ghost-button">关闭</button>
        </div>
      </header>

      <div class="aad-body">
        <aside class="aad-sidebar">
          <section class="aad-card">
            <h3>下载设置</h3>
            <label>分片上限 <input id="aad-max-segments" type="number" min="1" max="5000"></label>
            <label>同时下载视频 <input id="aad-video-concurrency" type="number" min="1" max="8"></label>
            <label>单视频分片并发 <input id="aad-segment-concurrency" type="number" min="1" max="16"></label>
            <label class="aad-check"><input id="aad-small-only" type="checkbox"> 只下载不超过分片上限的视频</label>
            <div class="aad-action-grid">
              <button type="button" id="aad-download-all">下载全部作者</button>
              <button type="button" id="aad-pause" class="ghost-button">暂停</button>
              <button type="button" id="aad-resume" class="ghost-button">继续</button>
              <button type="button" id="aad-clear" class="ghost-button">清空队列</button>
            </div>
          </section>

          <section class="aad-card">
            <h3>总体状态</h3>
            <div id="aad-summary" class="aad-summary"></div>
          </section>

          <section class="aad-card aad-authors-card">
            <h3>作者目录</h3>
            <div id="aad-authors" class="aad-authors"></div>
          </section>

          <section class="aad-card aad-tasks-card">
            <h3>活动任务</h3>
            <div id="aad-tasks" class="aad-tasks">暂无活动任务</div>
          </section>
        </aside>

        <main class="aad-main">
          <section class="aad-player-card">
            <video id="aad-player" controls playsinline preload="metadata"></video>
            <div>
              <h3 id="aad-player-title">选择一个已下载视频播放</h3>
              <p id="aad-player-meta">仅播放本地文件</p>
            </div>
          </section>

          <section class="aad-toolbar">
            <input id="aad-search" type="search" placeholder="搜索标题、作者、标签、ID">
            <select id="aad-filter">
              <option value="all">全部状态</option>
              <option value="downloaded">已下载</option>
              <option value="duplicate">跨作者重复</option>
              <option value="pending">未下载</option>
              <option value="queued">队列中</option>
              <option value="downloading">下载中</option>
              <option value="deferred">超过分片上限</option>
              <option value="failed">失败</option>
            </select>
            <button type="button" id="aad-prev" class="ghost-button">上一页</button>
            <span id="aad-page-label">第 1 页</span>
            <button type="button" id="aad-next" class="ghost-button">下一页</button>
          </section>

          <section id="aad-works" class="aad-works">
            <div class="aad-empty">尚未选择归档总目录</div>
          </section>

          <details class="aad-log-card">
            <summary>运行日志</summary>
            <pre id="aad-log"></pre>
          </details>
        </main>
      </div>`;
    document.body.append(panel);

    $("#aad-choose-root", panel).onclick = chooseRoot;
    $("#aad-rescan", panel).onclick = async () => {
      if (!state.root && !(await restoreRoot(true))) return chooseRoot();
      await scanRoot();
    };
    $("#aad-close", panel).onclick = () => { panel.hidden = true; };
    $("#aad-download-all", panel).onclick = enqueueAll;
    $("#aad-pause", panel).onclick = () => stopQueue(false);
    $("#aad-resume", panel).onclick = resumeQueue;
    $("#aad-clear", panel).onclick = clearQueue;
    $("#aad-search", panel).oninput = (event) => { state.search = event.target.value; state.page = 1; renderWorks(); };
    $("#aad-filter", panel).onchange = (event) => { state.filter = event.target.value; state.page = 1; renderWorks(); };
    $("#aad-prev", panel).onclick = () => { state.page = Math.max(1, state.page - 1); renderWorks(); };
    $("#aad-next", panel).onclick = () => {
      state.page = Math.min(Math.max(1, Math.ceil(filteredItems().length / PAGE_SIZE)), state.page + 1);
      renderWorks();
    };

    const settings = [
      ["#aad-max-segments", "maxSegments", 1, 5000],
      ["#aad-video-concurrency", "videoConcurrency", 1, 8],
      ["#aad-segment-concurrency", "segmentConcurrency", 1, 16]
    ];
    for (const [selector, key, min, max] of settings) {
      const input = $(selector, panel);
      input.value = state.settings[key];
      input.onchange = () => {
        state.settings[key] = clamp(input.value, min, max);
        input.value = state.settings[key];
        saveSettings();
      };
    }
    $("#aad-small-only", panel).checked = state.settings.smallOnly;
    $("#aad-small-only", panel).onchange = (event) => {
      state.settings.smallOnly = event.target.checked;
      saveSettings();
    };

    panel.addEventListener("click", (event) => {
      const play = event.target.closest("[data-aad-play]");
      if (play) playLocal(state.itemByKey.get(play.dataset.aadPlay));
      const enqueue = event.target.closest("[data-aad-enqueue]");
      if (enqueue) enqueueOne(state.itemByKey.get(enqueue.dataset.aadEnqueue));
      const authorFilter = event.target.closest("[data-aad-author]");
      if (authorFilter) {
        state.search = authorFilter.dataset.aadAuthor;
        $("#aad-search", panel).value = state.search;
        state.page = 1;
        renderWorks();
      }
    });

    return panel;
  }

  function installTopButton() {
    const topbar = $(".topbar");
    if (!topbar || $("#all-authors-open")) return;
    const button = document.createElement("button");
    button.id = "all-authors-open";
    button.type = "button";
    button.className = "aad-open-button";
    button.textContent = "全部作者归档";
    button.onclick = openPanel;
    topbar.append(button);
  }

  function openPanel() {
    const panel = ensureUi();
    panel.hidden = false;
    renderAll();
  }

  function renderSummary() {
    const element = $("#aad-summary");
    if (!element) return;
    const value = summary();
    const rows = [
      ["作者", value.authors],
      ["作品", value.total],
      ["已下载", value.downloaded],
      ["去重", value.duplicate],
      ["待处理", value.pending],
      ["超上限", value.deferred],
      ["失败", value.failed],
      ["本地大小", formatBytes(value.bytes)]
    ];
    element.innerHTML = rows.map(([label, count]) => `<div><strong>${escapeHtml(count)}</strong><span>${label}</span></div>`).join("");
  }

  function renderAuthors() {
    const element = $("#aad-authors");
    if (!element) return;
    if (!state.authors.length) {
      element.innerHTML = "<p class=\"aad-muted\">尚未扫描到作者目录</p>";
      return;
    }
    element.innerHTML = state.authors
      .slice()
      .sort((left, right) => left.folderName.localeCompare(right.folderName))
      .map((author) => {
        const name = author.author?.username || author.folderName;
        const stats = author.stats;
        return `<button type="button" class="aad-author-row" data-aad-author="${escapeAttr(author.folderName)}">
          <strong>${escapeHtml(name)}</strong>
          <span>${stats.downloaded + stats.duplicate}/${stats.total} · ${formatBytes(stats.bytes)}</span>
        </button>`;
      }).join("");
  }

  function renderTasks() {
    const element = $("#aad-tasks");
    if (!element) return;
    if (!state.active.size) {
      element.textContent = state.queue.length ? `队列中还有 ${state.queue.length} 个视频` : "暂无活动任务";
      return;
    }
    element.innerHTML = [...state.active.values()].map((task) => {
      const total = Math.max(1, task.totalSegments || 1);
      const percent = Math.round((task.doneSegments || 0) / total * 100);
      return `<div class="aad-task">
        <strong>${escapeHtml(task.item.author.author?.username || task.item.author.folderName)}</strong>
        <span>${escapeHtml(task.item.title || task.item.id)}</span>
        <small>${task.phase} · ${task.doneSegments || 0}/${task.totalSegments || "?"} · ${formatSpeed(task.speed || 0)}</small>
        <i><b style="width:${percent}%"></b></i>
      </div>`;
    }).join("");
  }

  function renderWorks() {
    const element = $("#aad-works");
    if (!element) return;
    const items = filteredItems();
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.page = Math.max(1, Math.min(pages, state.page));
    const pageItems = items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const label = $("#aad-page-label");
    if (label) label.textContent = `第 ${state.page}/${pages} 页 · ${items.length} 条`;

    if (!pageItems.length) {
      element.innerHTML = `<div class="aad-empty">${state.scanning ? "正在扫描目录…" : "没有符合条件的作品"}</div>`;
      return;
    }

    element.innerHTML = pageItems.map((item) => {
      const authorName = item.author.author?.username || item.author.folderName;
      const canPlay = item.status === "downloaded" || item.status === "duplicate";
      const canonical = item.status === "duplicate" ? item.duplicateOf : item;
      return `<article class="aad-work-card" data-key="${escapeAttr(item.key)}">
        <div class="aad-cover" data-aad-cover="${escapeAttr(item.key)}"><span>${formatDuration(item.durationSeconds)}</span></div>
        <div class="aad-work-body">
          <div class="aad-status aad-status-${escapeAttr(item.status)}">${statusText(item.status)}</div>
          <h3>${escapeHtml(item.title || item.id || "未命名")}</h3>
          <p>${escapeHtml(authorName)} · ${escapeHtml((item.tags || []).join(" · ") || "无标签")}</p>
          <small>ID ${escapeHtml(item.id || "—")} · ${Number.isFinite(item.segmentCount) ? `${item.segmentCount} 分片` : "分片未知"} · ${formatBytes(item.byteLength)}</small>
          ${item.error ? `<em title="${escapeAttr(item.error)}">${escapeHtml(item.error)}</em>` : ""}
          <div class="aad-card-actions">
            <button type="button" class="ghost-button" data-aad-play="${escapeAttr(canonical?.key || "")}" ${canPlay ? "" : "disabled"}>播放</button>
            <button type="button" data-aad-enqueue="${escapeAttr(canonical?.key || "")}" ${["downloaded", "duplicate", "queued", "analyzing", "downloading"].includes(item.status) ? "disabled" : ""}>加入下载</button>
          </div>
        </div>
      </article>`;
    }).join("");
    loadVisibleCovers(pageItems);
  }

  async function loadVisibleCovers(items) {
    for (const item of items) {
      const source = item.status === "duplicate" ? item.duplicateOf : item;
      if (!source?.coverHandle) continue;
      const target = $(`[data-aad-cover="${cssEscape(item.key)}"]`);
      if (!target || target.dataset.loaded) continue;
      try {
        let url = state.coverUrls.get(source.key);
        if (!url) {
          url = URL.createObjectURL(await source.coverHandle.getFile());
          state.coverUrls.set(source.key, url);
        }
        target.style.backgroundImage = `url("${url}")`;
        target.dataset.loaded = "1";
      } catch {
        // Keep placeholder.
      }
    }
  }

  function renderAll() {
    renderSummary();
    renderAuthors();
    renderTasks();
    renderWorks();
    const panel = $("#all-authors-center");
    if (!panel) return;
    $("#aad-download-all", panel).disabled = !state.root || state.scanning;
    $("#aad-pause", panel).disabled = !state.running;
    $("#aad-resume", panel).disabled = state.running || (!state.queue.length && !state.items.some((item) => item.status === "partial"));
    $("#aad-rescan", panel).disabled = state.scanning || state.running;
    $("#aad-choose-root", panel).disabled = state.scanning || state.running;
  }

  function enqueueOne(item) {
    if (!item || item.duplicateOf || ["downloaded", "queued", "analyzing", "downloading"].includes(item.status)) return;
    item.status = "queued";
    item.error = "";
    if (!state.queued.has(item.key)) {
      state.queued.add(item.key);
      state.queue.push(item.key);
    }
    sortQueue();
    renderAll();
    startQueue();
  }

  async function playLocal(item) {
    if (!item) return;
    if (item.status === "duplicate" && item.duplicateOf) item = item.duplicateOf;
    if (!item.videoHandle) {
      alert("这个作品还没有本地视频文件。");
      return;
    }
    revokePlayerUrls();
    const video = $("#aad-player");
    const title = $("#aad-player-title");
    const meta = $("#aad-player-meta");
    const file = await item.videoHandle.getFile();
    const fileUrl = URL.createObjectURL(file);
    state.playerUrls.push(fileUrl);
    title.textContent = item.title || item.id || "本地视频";
    meta.textContent = `${item.author.author?.username || item.author.folderName} · ${item.videoFile} · ${formatBytes(file.size)}`;

    if (/\.ts$/i.test(item.videoFile) && window.Hls?.isSupported()) {
      const duration = Math.max(1, Number(item.durationSeconds || 1));
      const playlist = new Blob([
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:",
        String(Math.ceil(duration)),
        "\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:",
        String(duration),
        ",\n",
        fileUrl,
        "\n#EXT-X-ENDLIST\n"
      ], { type: "application/vnd.apple.mpegurl" });
      const playlistUrl = URL.createObjectURL(playlist);
      state.playerUrls.push(playlistUrl);
      state.playerHls = new Hls({ enableWorker: true, lowLatencyMode: false });
      state.playerHls.loadSource(playlistUrl);
      state.playerHls.attachMedia(video);
    } else {
      video.src = fileUrl;
    }
    video.play().catch(() => {});
  }

  function revokePlayerUrls() {
    state.playerHls?.destroy();
    state.playerHls = null;
    for (const url of state.playerUrls) URL.revokeObjectURL(url);
    state.playerUrls = [];
    const video = $("#aad-player");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  function revokeCoverUrls() {
    for (const url of state.coverUrls.values()) URL.revokeObjectURL(url);
    state.coverUrls.clear();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }

  async function boot() {
    installTopButton();
    ensureUi();
    openPanel();
    const observer = new MutationObserver(installTopButton);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (await restoreRoot(false)) {
      updateScanMessage(`已恢复总目录：${state.root.name}，正在扫描…`);
      await scanRoot();
    } else {
      updateScanMessage("请选择归档总目录，例如 F:\\tools\\short_videos");
      renderAll();
    }

    window.ALL_AUTHORS_ARCHIVE = {
      version: VERSION,
      open: openPanel,
      chooseRoot,
      scan: scanRoot,
      downloadAll: enqueueAll,
      pause: () => stopQueue(false),
      get status() {
        return { root: state.root?.name || "", ...summary(), running: state.running, scanning: state.scanning };
      }
    };
    log("全部作者归档中心已加载；未加载任何单作者目录逻辑");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
