(() => {
  "use strict";

  const VERSION = "20260802-19";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  const TARGET_PAGE_SIZE = 48;
  const DB_NAME = "hq-archive-center";
  const DB_VERSION = 1;
  const HANDLE_STORE = "handles";
  const LAST_HANDLE_KEY = "last-author-folder";

  const state = {
    root: null,
    worksDir: null,
    author: null,
    works: [],
    rawWorks: [],
    items: new Map(),
    index: { version: VERSION, settings: {}, items: {} },
    settings: {
      maxSegments: 50,
      videoConcurrency: 2,
      segmentConcurrency: 6,
      smallOnly: true
    },
    filter: "all",
    search: "",
    page: 1,
    queue: [],
    queued: new Set(),
    active: new Map(),
    running: false,
    paused: false,
    controller: null,
    indexWrite: Promise.resolve(),
    objectUrls: new Map(),
    lastRenderToken: 0,
    loadingFolder: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(message, details, level = "log") {
    console[level](`[ARCHIVE CENTER ${VERSION}] ${message}`, details || "");
    const output = $("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeStringify(details)}`;
    const line = `[${time}] [归档中心] ${message}${suffix}\n`;
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `${line}${old}`.slice(0, 140000);
  }

  function safeStringify(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function clean(value, fallback = "未命名", max = 72) {
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

  function videoOf(item) {
    return item?.video && typeof item.video === "object" ? item.video : item || {};
  }

  function videoId(item) {
    const value = videoOf(item).id ?? videoOf(item).vid ?? videoOf(item).videoId ?? item?.id ?? "";
    return String(value);
  }

  function formatCount(value) {
    const n = Number(value || 0);
    if (n >= 100000000) return `${(n / 100000000).toFixed(n >= 1000000000 ? 0 : 1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
    return String(n);
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Number(value || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = Math.floor(seconds % 60);
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function formatSpeed(value) {
    return `${formatBytes(value)}/s`;
  }

  function statusText(status) {
    return ({
      downloaded: "已下载",
      queued: "队列中",
      downloading: "下载中",
      analyzing: "分析中",
      deferred: "大视频暂缓",
      failed: "失败",
      partial: "未完成",
      pending: "未下载"
    })[status] || status || "未下载";
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbSet(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readwrite");
      tx.objectStore(HANDLE_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function idbDelete(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readwrite");
      tx.objectStore(HANDLE_STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function permission(handle, request = false) {
    if (!handle) return false;
    const options = { mode: "readwrite" };
    if ((await handle.queryPermission(options)) === "granted") return true;
    if (request && (await handle.requestPermission(options)) === "granted") return true;
    return false;
  }

  async function readFile(directory, name) {
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  }

  async function readText(directory, name, fallback = "") {
    try { return await (await readFile(directory, name)).text(); }
    catch { return fallback; }
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

  async function directoryExists(directory, name) {
    try { await directory.getDirectoryHandle(name); return true; }
    catch { return false; }
  }

  function defaultIndex() {
    return {
      version: VERSION,
      updatedAt: new Date().toISOString(),
      settings: { ...state.settings },
      items: {}
    };
  }

  async function saveIndex() {
    if (!state.root) return;
    state.index.version = VERSION;
    state.index.updatedAt = new Date().toISOString();
    state.index.settings = { ...state.settings };
    state.index.items = {};
    for (const [id, item] of state.items) {
      state.index.items[id] = {
        folderName: item.folderName || "",
        status: item.status === "downloading" || item.status === "analyzing" ? "partial" : item.status,
        segmentCount: Number.isFinite(item.segmentCount) ? item.segmentCount : null,
        videoFile: item.videoFile || "",
        byteLength: Number(item.byteLength || 0),
        completedAt: item.completedAt || "",
        error: item.error || "",
        lastAttemptAt: item.lastAttemptAt || "",
        playlistUrl: item.playlistUrl || ""
      };
    }
    state.indexWrite = state.indexWrite
      .catch(() => {})
      .then(() => writeJson(state.root, "archive-index.json", state.index));
    return state.indexWrite;
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

  function workFolderName(work) {
    return `${String(work.index || 0).padStart(5, "0")}_${clean(work.title || work.id, work.id || "video", 56)}_${clean(work.id, "id", 32)}`;
  }

  function normalizeWork(work, index) {
    const value = work || {};
    return {
      index: Number(value.index || index + 1),
      id: String(value.id ?? value.videoId ?? ""),
      title: value.title || value.name || "",
      description: value.description || value.introduce || "",
      tags: Array.isArray(value.tags) ? value.tags : [],
      durationSeconds: Number(value.durationSeconds || value.time || 0),
      width: Number(value.width || 0),
      height: Number(value.height || 0),
      playCount: Number(value.playCount ?? value.playCnt ?? 0),
      likeCount: Number(value.likeCount ?? value.likedCnt ?? 0),
      commentCount: Number(value.commentCount ?? value.commentCnt ?? 0),
      collectCount: Number(value.collectCount ?? value.collectedCnt ?? 0),
      releaseDate: value.releaseDate || "",
      releaseDateLabel: value.releaseDateLabel || "",
      categories: value.categories || [],
      coverPath: value.coverPath || value.verticalCoverURL || value.coverURL || "",
      playPath: value.playPath || value.playURL || "",
      signedPlaylistUrl: value.signedPlaylistUrl || value.url || "",
      rawAuthor: value.rawAuthor || value.user || null
    };
  }

  async function scanLocalWorks() {
    const scanned = new Map();
    if (!state.worksDir) return scanned;
    let count = 0;
    for await (const [name, handle] of state.worksDir.entries()) {
      if (handle.kind !== "directory") continue;
      count += 1;
      const prefix = name.match(/^(\d{5})_/);
      let work = prefix ? state.works[Number(prefix[1]) - 1] : null;
      let metadata = null;
      if (!work) {
        metadata = await readJson(handle, "metadata.json", null);
        const id = String(metadata?.id || "");
        work = id ? state.works.find((entry) => entry.id === id) : null;
      }
      if (!work) continue;

      const download = await readJson(handle, "download.json", null);
      const videoFile = download?.fileName || ((await fileExists(handle, "video.mp4")) ? "video.mp4" : (await fileExists(handle, "video.ts")) ? "video.ts" : "");
      scanned.set(work.id, {
        folderName: name,
        download,
        videoFile,
        hasVideo: Boolean(videoFile && (download || state.index.items?.[work.id]?.status === "downloaded")),
        partial: Boolean(videoFile && !download)
      });
      if (count % 100 === 0) updateFolderStatus(`正在扫描本地作品目录：${count}`);
    }
    return scanned;
  }

  async function loadFolder(handle, requestPermission = false) {
    if (state.loadingFolder) return;
    state.loadingFolder = true;
    try {
      if (!(await permission(handle, requestPermission))) throw new Error("没有所选文件夹的读写权限");
      const author = await readJson(handle, "author.json", null);
      const worksRaw = await readJson(handle, "works.json", null);
      if (!author || !Array.isArray(worksRaw)) {
        throw new Error("这个文件夹不是作者归档目录：缺少 author.json 或 works.json。请选择“作者昵称_UID...”这一层文件夹。");
      }

      revokeObjectUrls();
      state.root = handle;
      state.worksDir = await handle.getDirectoryHandle("works", { create: true });
      state.author = author;
      state.rawWorks = await readJson(handle, "works.raw.json", []);
      state.works = worksRaw.map(normalizeWork);
      state.index = await readJson(handle, "archive-index.json", defaultIndex()) || defaultIndex();
      Object.assign(state.settings, state.index.settings || {});
      state.settings.maxSegments = clamp(state.settings.maxSegments, 1, 5000);
      state.settings.videoConcurrency = clamp(state.settings.videoConcurrency, 1, 6);
      state.settings.segmentConcurrency = clamp(state.settings.segmentConcurrency, 1, 16);
      state.settings.smallOnly = state.settings.smallOnly !== false;
      const exportState = await readJson(handle, "export-state.json", {});
      const completed = new Set(exportState.completed || []);
      const failed = exportState.failed || {};
      state.items.clear();

      updateFolderStatus(`正在扫描 ${state.works.length} 条本地元数据…`);
      const local = await scanLocalWorks();

      state.works.forEach((work) => {
        const saved = state.index.items?.[work.id] || {};
        const disk = local.get(work.id) || {};
        let status = "pending";
        if (disk.hasVideo || completed.has(work.id) || saved.status === "downloaded") status = "downloaded";
        else if (disk.partial || saved.status === "partial") status = "partial";
        else if (saved.status === "deferred") status = "deferred";
        else if (saved.status === "failed" || failed[work.id]) status = "failed";

        state.items.set(work.id, {
          ...work,
          folderName: disk.folderName || saved.folderName || workFolderName(work),
          status,
          segmentCount: (() => {
            const raw = disk.download?.segmentCount ?? saved.segmentCount;
            return raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
          })(),
          videoFile: disk.videoFile || saved.videoFile || "",
          byteLength: Number(disk.download?.byteLength ?? saved.byteLength ?? 0),
          completedAt: disk.download?.completedAt || saved.completedAt || "",
          error: failed[work.id] || saved.error || "",
          lastAttemptAt: saved.lastAttemptAt || "",
          playlistUrl: disk.download?.playlistUrl || saved.playlistUrl || ""
        });
      });

      state.queue = [];
      state.queued.clear();
      state.active.clear();
      state.running = false;
      state.paused = false;
      await idbSet(LAST_HANDLE_KEY, handle);
      await idbSet(`author-${author.uid || author.id || handle.name}`, handle);
      state.page = 1;
      applySettingsToUi();
      renderAll();
      updateFolderStatus(`已读取本地目录：${handle.name}`);
      log("已复用本地作者归档", {
        folder: handle.name,
        works: state.works.length,
        downloaded: [...state.items.values()].filter((item) => item.status === "downloaded").length
      });
    } finally {
      state.loadingFolder = false;
    }
  }

  async function chooseFolder() {
    if (typeof showDirectoryPicker !== "function") {
      alert("当前浏览器不支持直接读写本地文件夹，请使用最新版 Edge 或 Chrome。");
      return;
    }
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite", id: "hq-archive-center" });
      await loadFolder(handle, true);
    } catch (error) {
      if (error.name !== "AbortError") {
        log("选择本地文件夹失败", error.message, "error");
        alert(error.message);
      }
    }
  }

  async function restoreLastFolder(userGesture = false) {
    try {
      const handle = await idbGet(LAST_HANDLE_KEY);
      if (!handle) return false;
      if (!(await permission(handle, userGesture))) return false;
      await loadFolder(handle, false);
      return true;
    } catch (error) {
      log("恢复上次文件夹失败", error.message, "warn");
      return false;
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

  async function fetchTimed(url, init = {}, timeoutMs = 18000, parentSignal = state.controller?.signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason || "cancelled");
    if (parentSignal) parentSignal.aborted ? abort() : parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await nativeFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    }
  }

  async function apiGet(path, params = {}) {
    const api = currentApi();
    if (!api) throw new Error("网页 API 尚未连接，无法刷新视频播放地址");
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
    const text = await response.text();
    const decoded = decryptEnvelope(JSON.parse(text));
    if (Number(decoded.errorCode || 0) !== 0) throw new Error(decoded.message || `errorCode ${decoded.errorCode}`);
    return decoded;
  }

  function extractPlayable(payload) {
    const data = payload?.data || payload || {};
    const value = data.video || data;
    return data.url || value.url || value.playURL || value.playUrl || value.m3u8URL || value.m3u8Url || "";
  }

  async function freshPlayable(item) {
    const id = item.id;
    const paths = uniq([
      String(cfg.videoDetailPath || "videos/{id}").replace("{id}", encodeURIComponent(id)),
      `videos/${encodeURIComponent(id)}`,
      `shortVideos/${encodeURIComponent(id)}`,
      `newsVideos/${encodeURIComponent(id)}`
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
    }, 22000);
    if (!response.ok) throw new Error(`m3u8 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      const inflated = pako.inflate(bytes, { to: "string" });
      if (inflated.includes("#EXTM3U")) return inflated;
    } catch {
      // Plain text playlist.
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) {
      const preview = text.slice(0, 180).replace(/\s+/g, " ");
      throw new Error(`服务器没有返回有效 m3u8：${preview}`);
    }
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
        if (next < lines.length) {
          variants.push({
            bandwidth: Number(attrs.BANDWIDTH || 0),
            url: new URL(lines[next].trim(), current).href
          });
        }
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
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
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        sequence = Number(line.split(":")[1] || 0);
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
        key = { method: attrs.METHOD || "NONE", iv: attrs.IV || "" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
        if (attrs.URI) init = new URL(attrs.URI, sourceUrl).href;
      } else if (!line.startsWith("#")) {
        segments.push({
          url: new URL(line, sourceUrl).href,
          sequence,
          key: key ? { ...key } : null
        });
        sequence += 1;
      }
    }
    return { segments, init };
  }

  async function preparePlaylist(item, forceFresh = false) {
    const candidates = [];
    if (!forceFresh) {
      candidates.push(item.signedPlaylistUrl, item.playPath, item.playlistUrl);
    }
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
      const preferred = task?.preferredOrigin;
      const origins = uniq([preferred, ...resourceDomains()]);
      for (const domain of origins) {
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
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const sampleLength = Math.min(bytes.length, 2048);
    const sample = sampleLength ? new TextDecoder().decode(bytes.subarray(0, sampleLength)).trim() : "";
    if (!bytes.length) return { type: "empty", message: "响应为空" };
    if (contentType.includes("text/html") || /^<!doctype html|^<html|<h1>\s*404\s*<\/h1>/i.test(sample)) {
      return { type: "html404", message: `服务器返回 HTML：${sample.slice(0, 120)}` };
    }
    const maybeJson = contentType.includes("application/json") || (bytes.length < 32768 && /^[\[{]/.test(sample));
    if (maybeJson) {
      try {
        const parsed = JSON.parse(sample);
        return {
          type: "json",
          message: `服务器返回 JSON：${parsed.message || parsed.msg || parsed.error || safeStringify(parsed).slice(0, 160)}`
        };
      } catch {
        // Random encrypted bytes can begin with { or [.
      }
    }
    if (!response.ok) return { type: "http", message: `HTTP ${response.status}` };
    return null;
  }

  async function mediaBytes(url, task) {
    const errors = [];
    for (const candidate of mediaCandidates(url, task)) {
      const origin = (() => { try { return new URL(candidate).origin; } catch { return ""; } })();
      if (origin && task?.disabledOrigins?.has(origin)) continue;
      try {
        const response = await fetchTimed(candidate, {
          cache: "no-store",
          credentials: "omit",
          mode: "cors"
        }, 30000);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const problem = inspectResponse(response, bytes);
        if (problem) {
          if (origin && problem.type === "html404") {
            const next = (task.html404.get(origin) || 0) + 1;
            task.html404.set(origin, next);
            if (next >= 2) task.disabledOrigins.add(origin);
          }
          errors.push(`${origin || candidate}: ${problem.message}`);
          continue;
        }
        if (origin) {
          task.preferredOrigin = origin;
          task.html404.set(origin, 0);
        }
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
    if (String(keyInfo.method).toUpperCase() !== "AES-128") {
      throw new Error(`暂不支持 ${keyInfo.method} 分片加密`);
    }
    const rawKey = b64ToBytes(cfg.mediaKeyBase64);
    const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: parseIv(keyInfo.iv, sequence) }, cryptoKey, bytes);
    return new Uint8Array(decrypted);
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 12)).includes("ftypavi")) return "image/avif";
    return "";
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

  function decodeImage(bytes) {
    const raw = detectImageMime(bytes);
    if (raw) return { bytes, type: raw };
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
      const type = text.slice(5, text.indexOf(";")) || "image/webp";
      return { bytes: b64ToBytes(text.slice(comma + 1)), type };
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
    const candidates = [];
    for (const domain of resourceDomains()) {
      const original = joinUrl(domain, path);
      if (/\.(ceb|geb)(?:$|[?#])/i.test(original)) candidates.push(`${original}@webp-${size}`);
      candidates.push(original);
    }
    const errors = [];
    for (const candidate of uniq(candidates)) {
      try {
        const response = await fetchTimed(candidate, {
          cache: "force-cache",
          credentials: "omit",
          mode: "cors"
        }, 15000);
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

  async function getWorkDirectory(item, create = true) {
    if (!state.worksDir) throw new Error("尚未选择本地作者文件夹");
    return state.worksDir.getDirectoryHandle(item.folderName || workFolderName(item), { create });
  }

  async function ensureWorkFiles(item, directory) {
    if (!(await fileExists(directory, "metadata.json"))) await writeJson(directory, "metadata.json", item);
    if (item.coverPath) {
      const hasCover = await findFirstFile(directory, ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"]);
      if (!hasCover) {
        try {
          const image = await getRemoteImage(item.coverPath, 720);
          await writeFile(directory, `cover.${imageExtension(image.type)}`, image.bytes);
        } catch (error) {
          await writeFile(directory, "cover-error.txt", String(error.message || error));
        }
      }
    }
  }

  async function findFirstFile(directory, names) {
    for (const name of names) {
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        if (file.size > 0) return { name, handle, file };
      } catch {
        // Next file.
      }
    }
    return null;
  }

  function updateTaskProgress(task, done, total, bytes) {
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - task.speedAt) / 1000);
    const delta = Math.max(0, bytes - task.speedBytes);
    if (elapsed >= 0.5) {
      task.speed = delta / elapsed;
      task.speedAt = now;
      task.speedBytes = bytes;
    }
    task.doneSegments = done;
    task.totalSegments = total;
    task.bytes = bytes;
    renderTasks();
    updateCardState(task.item.id);
  }

  async function downloadPrepared(item, prepared, task) {
    const directory = await getWorkDirectory(item, true);
    item.folderName = directory.name;
    await ensureWorkFiles(item, directory);
    await writeFile(directory, "playlist.m3u8", prepared.text);

    const parsed = prepared.parsed;
    const fileName = parsed.init ? "video.mp4" : "video.ts";
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    let bytesWritten = 0;
    task.phase = "下载分片";
    task.totalSegments = parsed.segments.length;
    task.doneSegments = 0;
    task.speedAt = performance.now();
    task.speedBytes = 0;

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
    return download;
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
      html404: new Map(),
      disabledOrigins: new Set()
    };
    state.active.set(item.id, task);
    item.status = "analyzing";
    item.error = "";
    item.lastAttemptAt = new Date().toISOString();
    renderTasks();
    updateCardState(item.id);

    try {
      if (state.settings.smallOnly && Number.isFinite(item.segmentCount) && item.segmentCount > state.settings.maxSegments) {
        item.status = "deferred";
        return;
      }

      let prepared;
      try {
        prepared = await preparePlaylist(item, false);
      } catch {
        prepared = await preparePlaylist(item, true);
      }
      item.segmentCount = prepared.parsed.segments.length;
      item.playlistUrl = prepared.url;
      task.totalSegments = item.segmentCount;
      renderTasks();

      if (state.settings.smallOnly && item.segmentCount > state.settings.maxSegments) {
        item.status = "deferred";
        item.error = `分片 ${item.segmentCount}，超过当前阈值 ${state.settings.maxSegments}`;
        return;
      }

      item.status = "downloading";
      task.phase = "下载分片";
      updateCardState(item.id);
      const result = await downloadPrepared(item, prepared, task);
      item.status = "downloaded";
      item.videoFile = result.fileName;
      item.byteLength = result.byteLength;
      item.segmentCount = result.segmentCount;
      item.completedAt = result.completedAt;
      item.playlistUrl = result.playlistUrl;
      item.error = "";
      log("视频下载完成", {
        id: item.id,
        title: item.title,
        segments: result.segmentCount,
        size: formatBytes(result.byteLength)
      });
    } catch (error) {
      if (error?.name === "AbortError" || state.paused) {
        item.status = "queued";
        if (!state.queued.has(item.id)) {
          state.queued.add(item.id);
          state.queue.unshift(item.id);
        }
      } else {
        item.status = "failed";
        item.error = error.message || String(error);
        log("视频任务失败", { id: item.id, title: item.title, error: item.error }, "warn");
      }
    } finally {
      state.active.delete(item.id);
      await saveIndex();
      renderAll();
    }
  }

  function sortQueue() {
    state.queue.sort((leftId, rightId) => {
      const left = state.items.get(leftId);
      const right = state.items.get(rightId);
      const leftKnown = Number.isFinite(left?.segmentCount);
      const rightKnown = Number.isFinite(right?.segmentCount);
      if (leftKnown && rightKnown) return left.segmentCount - right.segmentCount || left.index - right.index;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return (left?.durationSeconds || 0) - (right?.durationSeconds || 0) || (left?.index || 0) - (right?.index || 0);
    });
  }

  function enqueueItems(items) {
    for (const item of items) {
      if (!item || item.status === "downloaded" || state.active.has(item.id) || state.queued.has(item.id)) continue;
      if (state.settings.smallOnly && Number.isFinite(item.segmentCount) && item.segmentCount > state.settings.maxSegments) {
        item.status = "deferred";
        continue;
      }
      state.queued.add(item.id);
      state.queue.push(item.id);
      item.status = "queued";
      item.error = "";
    }
    sortQueue();
    saveIndex();
    renderAll();
  }

  function dequeueItem(item) {
    state.queued.delete(item.id);
    state.queue = state.queue.filter((id) => id !== item.id);
    if (item.status === "queued") item.status = "pending";
    saveIndex();
    renderAll();
  }

  async function workerLoop(workerIndex) {
    while (state.running && !state.paused) {
      const id = state.queue.shift();
      if (!id) break;
      state.queued.delete(id);
      const item = state.items.get(id);
      if (!item || item.status === "downloaded") continue;
      await processItem(item);
      if (state.paused) break;
      await sleep(30 * workerIndex);
    }
  }

  async function startQueue() {
    if (!state.root) return chooseFolder();
    if (state.running && !state.paused) return;
    if (!state.queue.length) {
      enqueueItems([...state.items.values()].filter((item) => item.status !== "downloaded"));
    }
    state.running = true;
    state.paused = false;
    state.controller = new AbortController();
    renderAll();
    const workers = Array.from({ length: clamp(state.settings.videoConcurrency, 1, 6) }, (_, index) => workerLoop(index + 1));
    await Promise.allSettled(workers);
    if (!state.paused) state.running = false;
    state.controller = null;
    renderAll();
  }

  function pauseQueue() {
    if (!state.running) return;
    state.paused = true;
    state.running = false;
    state.controller?.abort("paused");
    renderAll();
  }

  function clearQueue() {
    if (state.running) pauseQueue();
    for (const id of state.queue) {
      const item = state.items.get(id);
      if (item?.status === "queued") item.status = "pending";
    }
    state.queue = [];
    state.queued.clear();
    saveIndex();
    renderAll();
  }

  function retryFailed() {
    enqueueItems([...state.items.values()].filter((item) => item.status === "failed" || item.status === "partial"));
  }

  function queueSmall() {
    state.settings.smallOnly = true;
    syncSettingsFromUi();
    enqueueItems([...state.items.values()].filter((item) => item.status !== "downloaded"));
  }

  function queueAll() {
    if (!confirm("这会把分片很多的大视频也加入队列，可能持续数小时并占用大量磁盘空间。继续吗？")) return;
    state.settings.smallOnly = false;
    applySettingsToUi();
    enqueueItems([...state.items.values()].filter((item) => item.status !== "downloaded"));
  }

  function filteredItems() {
    const query = state.search.trim().toLowerCase();
    return [...state.items.values()].filter((item) => {
      if (query) {
        const haystack = `${item.id} ${item.title} ${item.description} ${(item.tags || []).join(" ")}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      switch (state.filter) {
        case "downloaded": return item.status === "downloaded";
        case "pending": return ["pending", "partial"].includes(item.status);
        case "queued": return item.status === "queued" || state.active.has(item.id);
        case "failed": return item.status === "failed";
        case "small": return Number.isFinite(item.segmentCount) && item.segmentCount <= state.settings.maxSegments;
        case "large": return Number.isFinite(item.segmentCount) && item.segmentCount > state.settings.maxSegments;
        case "unknown": return !Number.isFinite(item.segmentCount);
        default: return true;
      }
    });
  }

  function revokeObjectUrls() {
    for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
    state.objectUrls.clear();
  }

  async function localCoverUrl(item) {
    const cacheKey = `cover:${item.id}`;
    if (state.objectUrls.has(cacheKey)) return state.objectUrls.get(cacheKey);
    try {
      const directory = await getWorkDirectory(item, false);
      const found = await findFirstFile(directory, ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"]);
      if (!found) return "";
      const url = URL.createObjectURL(found.file);
      state.objectUrls.set(cacheKey, url);
      return url;
    } catch {
      return "";
    }
  }

  async function localAuthorAvatarUrl() {
    const cacheKey = "author-avatar";
    if (state.objectUrls.has(cacheKey)) return state.objectUrls.get(cacheKey);
    try {
      const assets = await state.root.getDirectoryHandle("assets");
      const found = await findFirstFile(assets, ["avatar.webp", "avatar.jpg", "avatar.jpeg", "avatar.png", "avatar.avif"]);
      if (!found) return "";
      const url = URL.createObjectURL(found.file);
      state.objectUrls.set(cacheKey, url);
      return url;
    } catch {
      return "";
    }
  }

  async function playLocal(item) {
    if (item.status !== "downloaded") return;
    try {
      const directory = await getWorkDirectory(item, false);
      let fileName = item.videoFile;
      if (!fileName) {
        const download = await readJson(directory, "download.json", null);
        fileName = download?.fileName || "";
      }
      if (!fileName) {
        const found = await findFirstFile(directory, ["video.mp4", "video.ts"]);
        fileName = found?.name || "";
      }
      if (!fileName) throw new Error("没有找到本地视频文件");
      const file = await (await directory.getFileHandle(fileName)).getFile();
      const cacheKey = `video:${item.id}`;
      const previous = state.objectUrls.get(cacheKey);
      if (previous) URL.revokeObjectURL(previous);
      const mime = fileName.endsWith(".mp4") ? "video/mp4" : "video/mp2t";
      const url = URL.createObjectURL(file.type ? file : new Blob([file], { type: mime }));
      state.objectUrls.set(cacheKey, url);

      const player = $("#archive-local-player");
      player.pause();
      player.src = url;
      player.load();
      $("#archive-player-title").textContent = item.title || item.id;
      $("#archive-player-meta").textContent = `${formatDuration(item.durationSeconds)} · ${formatBytes(file.size)} · ${(item.tags || []).join(" · ") || "无标签"}`;
      $("#archive-player-description").textContent = item.description || "暂无描述";
      $("#archive-player-note").textContent = "";
      try { await player.play(); }
      catch {
        $("#archive-player-note").textContent = fileName.endsWith(".ts")
          ? "这个文件是 MPEG-TS。当前浏览器若不能直接解码，可在资源管理器中用 VLC 或 PotPlayer 打开。"
          : "浏览器阻止了自动播放，请点击播放按钮。";
      }
      panel().querySelector(".archive-center-player")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      alert(`本地播放失败：${error.message}`);
    }
  }

  function panel() {
    let root = $("#archive-center");
    if (root) return root;
    root = document.createElement("div");
    root.id = "archive-center";
    root.hidden = true;
    root.innerHTML = `
      <div class="archive-center-backdrop"></div>
      <section class="archive-center-shell" role="dialog" aria-modal="true" aria-label="本地归档下载中心">
        <header class="archive-center-header">
          <div class="archive-center-author">
            <img id="archive-author-avatar" alt="作者头像">
            <div>
              <p class="archive-kicker">LOCAL ARCHIVE</p>
              <h2 id="archive-author-name">本地归档下载中心</h2>
              <p id="archive-folder-status">尚未选择作者文件夹</p>
            </div>
          </div>
          <div class="archive-center-header-actions">
            <button type="button" id="archive-choose-folder">选择作者文件夹</button>
            <button type="button" id="archive-refresh-folder" class="ghost-button">重新读取</button>
            <button type="button" id="archive-close" class="ghost-button">关闭</button>
          </div>
        </header>

        <div class="archive-center-body">
          <aside class="archive-center-sidebar">
            <section class="archive-center-card archive-settings">
              <h3>下载设置</h3>
              <label>优先分片上限 <input id="archive-max-segments" type="number" min="1" max="5000" value="50"></label>
              <label>同时下载视频 <input id="archive-video-concurrency" type="number" min="1" max="6" value="2"></label>
              <label>单视频分片并发 <input id="archive-segment-concurrency" type="number" min="1" max="16" value="6"></label>
              <label class="archive-check"><input id="archive-small-only" type="checkbox" checked> 只自动下载不超过阈值的视频</label>
              <div class="archive-settings-actions">
                <button type="button" id="archive-queue-small">加入短视频</button>
                <button type="button" id="archive-queue-all" class="ghost-button">加入全部</button>
              </div>
              <div class="archive-settings-actions">
                <button type="button" id="archive-start">开始下载</button>
                <button type="button" id="archive-pause" class="ghost-button">暂停</button>
                <button type="button" id="archive-clear" class="ghost-button">清空队列</button>
              </div>
              <button type="button" id="archive-retry" class="ghost-button archive-wide-button">重试失败和未完成</button>
            </section>

            <section class="archive-center-card archive-summary">
              <h3>本地状态</h3>
              <div id="archive-summary-grid"></div>
            </section>

            <section class="archive-center-card archive-tasks-card">
              <h3>活动任务</h3>
              <div id="archive-task-list"><p class="archive-empty">暂无活动任务</p></div>
            </section>
          </aside>

          <main class="archive-center-main">
            <section class="archive-center-card archive-center-player">
              <video id="archive-local-player" controls playsinline preload="metadata"></video>
              <div class="archive-player-copy">
                <h3 id="archive-player-title">选择一个已下载视频播放</h3>
                <p id="archive-player-meta">本地文件不会重新走网络</p>
                <p id="archive-player-description"></p>
                <p id="archive-player-note"></p>
              </div>
            </section>

            <section class="archive-center-card archive-library-card">
              <div class="archive-library-toolbar">
                <input id="archive-search" type="search" placeholder="搜索标题、标签、ID">
                <select id="archive-filter">
                  <option value="all">全部</option>
                  <option value="downloaded">已下载</option>
                  <option value="pending">未下载</option>
                  <option value="queued">队列与下载中</option>
                  <option value="failed">失败</option>
                  <option value="small">小于阈值</option>
                  <option value="large">大于阈值</option>
                  <option value="unknown">分片数未知</option>
                </select>
                <button type="button" id="archive-prev" class="ghost-button">上一页</button>
                <span id="archive-page-label">第 1 页</span>
                <button type="button" id="archive-next" class="ghost-button">下一页</button>
              </div>
              <div id="archive-library" class="archive-library"><p class="archive-empty">选择已有作者归档文件夹后显示内容</p></div>
            </section>
          </main>
        </div>
      </section>`;
    document.body.append(root);

    $("#archive-close", root).addEventListener("click", closePanel);
    $(".archive-center-backdrop", root).addEventListener("click", closePanel);
    $("#archive-choose-folder", root).addEventListener("click", chooseFolder);
    $("#archive-refresh-folder", root).addEventListener("click", async () => {
      if (state.root) await loadFolder(state.root, true);
      else await chooseFolder();
    });
    $("#archive-queue-small", root).addEventListener("click", queueSmall);
    $("#archive-queue-all", root).addEventListener("click", queueAll);
    $("#archive-start", root).addEventListener("click", startQueue);
    $("#archive-pause", root).addEventListener("click", pauseQueue);
    $("#archive-clear", root).addEventListener("click", clearQueue);
    $("#archive-retry", root).addEventListener("click", retryFailed);
    $("#archive-search", root).addEventListener("input", (event) => {
      state.search = event.target.value;
      state.page = 1;
      renderLibrary();
    });
    $("#archive-filter", root).addEventListener("change", (event) => {
      state.filter = event.target.value;
      state.page = 1;
      renderLibrary();
    });
    $("#archive-prev", root).addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      renderLibrary();
    });
    $("#archive-next", root).addEventListener("click", () => {
      const pages = Math.max(1, Math.ceil(filteredItems().length / TARGET_PAGE_SIZE));
      state.page = Math.min(pages, state.page + 1);
      renderLibrary();
    });
    ["#archive-max-segments", "#archive-video-concurrency", "#archive-segment-concurrency", "#archive-small-only"].forEach((selector) => {
      $(selector, root).addEventListener("change", () => {
        syncSettingsFromUi();
        saveIndex();
        renderAll();
      });
    });
    root.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-archive-action]");
      if (!action) return;
      const item = state.items.get(action.dataset.id);
      if (!item) return;
      if (action.dataset.archiveAction === "play") await playLocal(item);
      if (action.dataset.archiveAction === "queue") enqueueItems([item]);
      if (action.dataset.archiveAction === "dequeue") dequeueItem(item);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !root.hidden) closePanel();
    });
    return root;
  }

  function openPanel() {
    const root = panel();
    root.hidden = false;
    document.body.classList.add("archive-center-open");
    renderAll();
    if (!state.root) {
      restoreLastFolder(true).then((restored) => {
        if (!restored) updateFolderStatus("请选择 F:\\tools\\short_videos 下已有的“作者昵称_UID...”文件夹");
      });
    }
  }

  function closePanel() {
    const root = panel();
    root.hidden = true;
    document.body.classList.remove("archive-center-open");
  }

  function updateFolderStatus(text) {
    const element = $("#archive-folder-status");
    if (element) element.textContent = text;
  }

  function syncSettingsFromUi() {
    const root = panel();
    state.settings.maxSegments = clamp($("#archive-max-segments", root).value, 1, 5000);
    state.settings.videoConcurrency = clamp($("#archive-video-concurrency", root).value, 1, 6);
    state.settings.segmentConcurrency = clamp($("#archive-segment-concurrency", root).value, 1, 16);
    state.settings.smallOnly = $("#archive-small-only", root).checked;
    localStorage.setItem("hq-archive-center-settings", JSON.stringify(state.settings));
  }

  function applySettingsToUi() {
    const root = panel();
    $("#archive-max-segments", root).value = state.settings.maxSegments;
    $("#archive-video-concurrency", root).value = state.settings.videoConcurrency;
    $("#archive-segment-concurrency", root).value = state.settings.segmentConcurrency;
    $("#archive-small-only", root).checked = state.settings.smallOnly;
  }

  function renderSummary() {
    const items = [...state.items.values()];
    const downloaded = items.filter((item) => item.status === "downloaded").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const deferred = items.filter((item) => item.status === "deferred").length;
    const knownSmall = items.filter((item) => Number.isFinite(item.segmentCount) && item.segmentCount <= state.settings.maxSegments).length;
    const bytes = items.reduce((sum, item) => sum + Number(item.byteLength || 0), 0);
    const grid = $("#archive-summary-grid");
    if (!grid) return;
    grid.innerHTML = `
      <div><strong>${items.length}</strong><span>作品总数</span></div>
      <div><strong>${downloaded}</strong><span>已下载</span></div>
      <div><strong>${state.queue.length}</strong><span>等待队列</span></div>
      <div><strong>${state.active.size}</strong><span>活动任务</span></div>
      <div><strong>${knownSmall}</strong><span>已知短视频</span></div>
      <div><strong>${deferred}</strong><span>大视频暂缓</span></div>
      <div><strong>${failed}</strong><span>失败</span></div>
      <div><strong>${formatBytes(bytes)}</strong><span>已归档体积</span></div>`;
  }

  function renderTasks() {
    const list = $("#archive-task-list");
    if (!list) return;
    const tasks = [...state.active.values()];
    if (!tasks.length) {
      list.innerHTML = state.queue.length
        ? `<p class="archive-empty">队列中还有 ${state.queue.length} 个视频</p>`
        : `<p class="archive-empty">暂无活动任务</p>`;
      return;
    }
    list.innerHTML = tasks.map((task) => {
      const percent = task.totalSegments ? (task.doneSegments / task.totalSegments) * 100 : 0;
      return `<article class="archive-task" data-task-id="${escapeHtml(task.item.id)}">
        <strong>${escapeHtml(task.item.title || task.item.id)}</strong>
        <span>${escapeHtml(task.phase)} · ${task.doneSegments}/${task.totalSegments || "?"}</span>
        <div><i style="width:${percent.toFixed(2)}%"></i></div>
        <small>${formatBytes(task.bytes)} · ${formatSpeed(task.speed)}</small>
      </article>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function cardMarkup(item) {
    const active = state.active.get(item.id);
    const status = active ? "downloading" : item.status;
    const count = Number.isFinite(item.segmentCount) ? `${item.segmentCount} 分片` : "分片未知";
    const queueAction = state.queued.has(item.id)
      ? `<button type="button" data-archive-action="dequeue" data-id="${escapeHtml(item.id)}">移出队列</button>`
      : item.status === "downloaded"
        ? ""
        : `<button type="button" data-archive-action="queue" data-id="${escapeHtml(item.id)}">加入队列</button>`;
    const playButton = item.status === "downloaded"
      ? `<button type="button" data-archive-action="play" data-id="${escapeHtml(item.id)}">播放</button>`
      : "";
    return `<article class="archive-work-card" data-work-id="${escapeHtml(item.id)}" data-status="${escapeHtml(status)}">
      <div class="archive-work-cover">
        <img alt="" data-local-cover="${escapeHtml(item.id)}">
        <span class="archive-work-duration">${formatDuration(item.durationSeconds)}</span>
        <span class="archive-work-status">${statusText(status)}</span>
      </div>
      <div class="archive-work-body">
        <h4 title="${escapeHtml(item.title)}">${escapeHtml(item.title || item.id)}</h4>
        <p class="archive-work-tags">${escapeHtml((item.tags || []).slice(0, 5).join(" · ") || "无标签")}</p>
        <p class="archive-work-stats">▶ ${formatCount(item.playCount)}　♥ ${formatCount(item.likeCount)}　💬 ${formatCount(item.commentCount)}</p>
        <p class="archive-work-segments">${count}${item.byteLength ? ` · ${formatBytes(item.byteLength)}` : ""}</p>
        ${item.error ? `<p class="archive-work-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</p>` : ""}
        <div class="archive-work-actions">${playButton}${queueAction}</div>
      </div>
    </article>`;
  }

  async function hydrateCovers(container, tokenValue) {
    const images = $$('[data-local-cover]', container);
    await Promise.all(images.map(async (image) => {
      const item = state.items.get(image.dataset.localCover);
      if (!item) return;
      const url = await localCoverUrl(item);
      if (tokenValue !== state.lastRenderToken || !image.isConnected) return;
      if (url) image.src = url;
      else image.removeAttribute("src");
    }));
  }

  function renderLibrary() {
    const container = $("#archive-library");
    if (!container) return;
    if (!state.root) {
      container.innerHTML = `<p class="archive-empty">请选择已有作者归档文件夹。刷新后会读取本地 works.json，不会重新抓取作者全部作品。</p>`;
      return;
    }
    const items = filteredItems();
    const pages = Math.max(1, Math.ceil(items.length / TARGET_PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * TARGET_PAGE_SIZE;
    const pageItems = items.slice(start, start + TARGET_PAGE_SIZE);
    $("#archive-page-label").textContent = `第 ${state.page}/${pages} 页 · ${items.length} 条`;
    $("#archive-prev").disabled = state.page <= 1;
    $("#archive-next").disabled = state.page >= pages;
    container.innerHTML = pageItems.length
      ? pageItems.map(cardMarkup).join("")
      : `<p class="archive-empty">没有符合条件的作品</p>`;
    const tokenValue = ++state.lastRenderToken;
    hydrateCovers(container, tokenValue);
  }

  function updateCardState(id) {
    const item = state.items.get(id);
    const card = $(`.archive-work-card[data-work-id="${CSS.escape(id)}"]`);
    if (!item || !card) return;
    const active = state.active.get(id);
    card.dataset.status = active ? "downloading" : item.status;
    const badge = $(".archive-work-status", card);
    if (badge) badge.textContent = statusText(active ? "downloading" : item.status);
    const segments = $(".archive-work-segments", card);
    if (segments) segments.textContent = `${Number.isFinite(item.segmentCount) ? `${item.segmentCount} 分片` : "分片未知"}${item.byteLength ? ` · ${formatBytes(item.byteLength)}` : ""}`;
  }

  async function renderAuthor() {
    const name = $("#archive-author-name");
    const status = $("#archive-folder-status");
    const avatar = $("#archive-author-avatar");
    if (!state.author) {
      name.textContent = "本地归档下载中心";
      status.textContent = "尚未选择作者文件夹";
      avatar.removeAttribute("src");
      return;
    }
    name.textContent = `${state.author.username || "未知作者"} · UID ${state.author.uid || state.author.id || "—"}`;
    status.textContent = `${state.root.name} · 本地 ${state.works.length} 条作品元数据`;
    const url = await localAuthorAvatarUrl();
    if (url) avatar.src = url;
    else avatar.removeAttribute("src");
  }

  function renderControls() {
    const root = panel();
    $("#archive-start", root).textContent = state.running ? "下载中" : state.paused ? "继续下载" : "开始下载";
    $("#archive-start", root).disabled = state.running && !state.paused;
    $("#archive-pause", root).disabled = !state.running;
    $("#archive-clear", root).disabled = !state.queue.length && !state.active.size;
  }

  function renderAll() {
    panel();
    renderSummary();
    renderTasks();
    renderControls();
    renderLibrary();
    renderAuthor();
  }

  function installEntryButtons() {
    if (!$("#archive-center-open")) {
      const button = document.createElement("button");
      button.id = "archive-center-open";
      button.type = "button";
      button.textContent = "本地归档中心";
      button.className = "archive-center-entry";
      button.addEventListener("click", openPanel);
      const topbar = $(".topbar");
      (topbar || document.body).append(button);
    }

    const modal = $("#author-modal");
    if (modal && !$(".archive-center-author-button", modal)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "archive-center-author-button";
      button.textContent = "打开本地归档中心";
      button.addEventListener("click", openPanel);
      ($(".author-works-heading", modal) || $(".author-header", modal) || modal).append(button);
      const old = $(".author-export-button", modal);
      if (old) old.textContent = "一键顺序归档";
    }
  }

  async function boot() {
    panel();
    try {
      const stored = JSON.parse(localStorage.getItem("hq-archive-center-settings") || "{}");
      Object.assign(state.settings, stored);
    } catch {
      // Defaults.
    }
    applySettingsToUi();
    installEntryButtons();
    new MutationObserver(installEntryButtons).observe(document.documentElement, { childList: true, subtree: true });
    const handle = await idbGet(LAST_HANDLE_KEY).catch(() => null);
    if (handle && (await permission(handle, false))) {
      loadFolder(handle, false).catch((error) => log("自动读取上次文件夹失败", error.message, "warn"));
    }
    window.ARCHIVE_CENTER = {
      version: VERSION,
      open: openPanel,
      chooseFolder,
      start: startQueue,
      pause: pauseQueue,
      get summary() {
        return {
          folder: state.root?.name || "",
          works: state.items.size,
          queue: state.queue.length,
          active: state.active.size,
          running: state.running,
          settings: { ...state.settings }
        };
      },
      forgetFolder: async () => {
        await idbDelete(LAST_HANDLE_KEY);
        state.root = null;
        state.author = null;
        state.works = [];
        state.items.clear();
        renderAll();
      }
    };
    log("本地归档下载中心已加载", { version: VERSION, fileSystemAccess: typeof showDirectoryPicker === "function" });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
