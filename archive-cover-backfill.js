(() => {
  "use strict";

  const VERSION = "20260803-34-downloaded-cover-backfill";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const COVER_NAMES = ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"];
  const VIDEO_NAMES = ["video.ts", "video.mp4", "video.webm", "video.mkv"];
  const CONCURRENCY = 3;

  const state = {
    running: false,
    timer: 0,
    lastRunAt: 0,
    observer: null,
    interval: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const uniq = (values) => [...new Set(values.filter(Boolean))];

  function log(message, details, level = "log") {
    console[level](`[ARCHIVE COVER ${VERSION}] ${message}`, details ?? "");
    const output = $("#aad-log");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let suffix = "";
    if (details !== undefined) {
      try { suffix = `\n${JSON.stringify(details, null, 2)}`; }
      catch { suffix = `\n${String(details)}`; }
    }
    output.textContent = `[${time}] [封面补齐] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
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

  function joinUrl(base, path) {
    return new URL(String(path || "").replace(/^\/+/, ""), normalizeBase(base)).href;
  }

  function openDatabase() {
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
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
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

  async function getRoot(requestPermission = false) {
    const root = await idbGet(ROOT_KEY).catch(() => null);
    if (root && await permission(root, requestPermission)) return root;
    return null;
  }

  async function readJson(directory, name, fallback = null) {
    try {
      const handle = await directory.getFileHandle(name);
      return JSON.parse(await (await handle.getFile()).text());
    } catch {
      return fallback;
    }
  }

  async function existingFile(directory, names) {
    for (const name of names) {
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        if (file.size > 0) return { name, handle, file };
      } catch {
        // Try the next known file name.
      }
    }
    return null;
  }

  async function writeFile(directory, name, data) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(data); }
    finally { await writable.close(); }
  }

  function workFolderName(work) {
    return `${String(work.index || 0).padStart(5, "0")}_${clean(work.title || work.id, work.id || "video", 56)}_${clean(work.id, "id", 32)}`;
  }

  async function findWorkDirectory(worksDirectory, work) {
    try {
      return await worksDirectory.getDirectoryHandle(workFolderName(work));
    } catch {
      // Older downloads may have a slightly different sanitized title. Match by video ID below.
    }

    const id = String(work.id || "").trim();
    if (!id) return null;
    for await (const entry of worksDirectory.values()) {
      if (entry.kind !== "directory") continue;
      if (entry.name.endsWith(`_${id}`) || entry.name.includes(id)) return entry;
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

  function wordArrayToBytes(wordArray) {
    const length = Number(wordArray?.sigBytes || 0);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 255;
    }
    return bytes;
  }

  function detectMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 12)).startsWith("ftyp")) return "image/avif";
    return "";
  }

  function decodeImage(bytes) {
    const directMime = detectMime(bytes);
    if (directMime) return { bytes, type: directMime };

    if (!window.CryptoJS) throw new Error("CryptoJS 未加载，无法解密封面");
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
        const type = detectMime(decoded);
        if (type) return { bytes: decoded, type };
      } catch {
        // Fall back to decrypted binary bytes.
      }
    }

    const decodedBytes = wordArrayToBytes(decrypted);
    const decodedMime = detectMime(decodedBytes);
    if (!decodedMime) throw new Error("封面解密后不是可识别图片");
    return { bytes: decodedBytes, type: decodedMime };
  }

  function extension(type) {
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
      const parsed = JSON.parse($("#domain-json")?.textContent || "{}");
      const data = parsed?.decoded?.data || parsed?.decoded || parsed?.data || parsed;
      dynamic = data?.resDomains || data?.resourceDomains || data?.resourceUrls || data?.resUrls || [];
    } catch {
      dynamic = [];
    }
    const displayed = normalizeBase($("#active-resource")?.textContent || "");
    return uniq([displayed, ...(Array.isArray(dynamic) ? dynamic : [dynamic])].map(normalizeBase));
  }

  function coverCandidates(path) {
    const value = String(path || "").trim();
    if (!value) return [];
    const output = [];

    if (/^https?:\/\//i.test(value)) {
      if (/\.(ceb|geb)(?:$|[?#])/i.test(value)) output.push(`${value}@webp-720`);
      output.push(value);
      return uniq(output);
    }

    for (const domain of resourceDomains()) {
      const original = joinUrl(domain, value);
      if (/\.(ceb|geb)(?:$|[?#])/i.test(original)) output.push(`${original}@webp-720`);
      output.push(original);
    }
    return uniq(output);
  }

  async function downloadCover(path) {
    const errors = [];
    for (const candidate of coverCandidates(path)) {
      try {
        const response = await fetch(candidate, {
          method: "GET",
          cache: "force-cache",
          credentials: "omit",
          mode: "cors"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error("空响应");
        return decodeImage(bytes);
      } catch (error) {
        errors.push(`${candidate}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | ") || "没有可用的封面资源地址");
  }

  function normalizeWork(value, index) {
    const work = value?.video && typeof value.video === "object" ? value.video : value || {};
    return {
      index: Number(value?.index || work.index || index + 1),
      id: String(work.id ?? work.videoId ?? work.vid ?? value?.id ?? ""),
      title: work.title || work.name || "",
      coverPath: work.coverPath || work.verticalCoverURL || work.coverURL || work.coverUrl || work.cover || ""
    };
  }

  async function collectMissing(root) {
    const jobs = [];
    let downloadedVideos = 0;
    let existingCovers = 0;
    let noCoverMetadata = 0;

    for await (const authorEntry of root.values()) {
      if (authorEntry.kind !== "directory") continue;
      const rawWorks = await readJson(authorEntry, "works.json", null);
      if (!Array.isArray(rawWorks) || !rawWorks.length) continue;

      let worksDirectory;
      try { worksDirectory = await authorEntry.getDirectoryHandle("works"); }
      catch { continue; }

      const works = rawWorks.map(normalizeWork);
      for (const work of works) {
        const workDirectory = await findWorkDirectory(worksDirectory, work);
        if (!workDirectory) continue;
        const video = await existingFile(workDirectory, VIDEO_NAMES);
        if (!video) continue;
        downloadedVideos += 1;

        if (await existingFile(workDirectory, COVER_NAMES)) {
          existingCovers += 1;
          continue;
        }
        if (!work.coverPath) {
          noCoverMetadata += 1;
          log("视频已下载，但作品元数据没有封面地址", {
            author: authorEntry.name,
            id: work.id,
            title: work.title,
            videoFile: video.name
          }, "warn");
          continue;
        }
        jobs.push({ authorEntry, workDirectory, work, videoFile: video.name });
      }
    }

    return { jobs, downloadedVideos, existingCovers, noCoverMetadata };
  }

  async function runPool(items, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, items.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    });
    await Promise.all(runners);
  }

  async function backfill(options = {}) {
    if (state.running) return { skipped: "already-running" };
    const requestPermission = options.requestPermission === true;
    const reason = options.reason || "自动检查";
    const root = await getRoot(requestPermission);
    if (!root) {
      if (requestPermission) alert("请先在“全部作者归档”中选择归档总目录。");
      return { skipped: "no-root" };
    }

    state.running = true;
    state.lastRunAt = Date.now();
    log(`开始${reason}：检查已下载视频是否缺少封面`);
    try {
      const summary = await collectMissing(root);
      let saved = 0;
      let failed = 0;

      await runPool(summary.jobs, async (job) => {
        try {
          const image = await downloadCover(job.work.coverPath);
          await writeFile(job.workDirectory, `cover.${extension(image.type)}`, image.bytes);
          saved += 1;
          log("已补齐下载视频的封面", {
            author: job.authorEntry.name,
            id: job.work.id,
            title: job.work.title,
            videoFile: job.videoFile,
            coverFile: `cover.${extension(image.type)}`
          });
        } catch (error) {
          failed += 1;
          log("补齐封面失败，稍后会自动重试", {
            author: job.authorEntry.name,
            id: job.work.id,
            title: job.work.title,
            coverPath: job.work.coverPath,
            error: error.message || String(error)
          }, "warn");
        }
      });

      const result = {
        reason,
        downloadedVideos: summary.downloadedVideos,
        existingCovers: summary.existingCovers,
        missingFound: summary.jobs.length,
        saved,
        failed,
        noCoverMetadata: summary.noCoverMetadata
      };
      log("已下载视频封面检查完成", result);
      if (saved) await window.ALL_AUTHORS_ARCHIVE?.scan?.();
      return result;
    } finally {
      state.running = false;
      state.lastRunAt = Date.now();
    }
  }

  function schedule(reason = "下载状态变化") {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (Date.now() - state.lastRunAt < 2500) return;
      backfill({ reason }).catch((error) => log("自动补齐封面检查失败", error.message || String(error), "warn"));
    }, 1800);
  }

  function installButton() {
    const actions = $("#all-authors-center .aad-header-actions");
    if (!actions || $("#aad-cover-backfill", actions)) return;
    const button = document.createElement("button");
    button.id = "aad-cover-backfill";
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = "补齐已下载封面";
    button.onclick = async () => {
      const old = button.textContent;
      button.disabled = true;
      button.textContent = "正在检查…";
      try {
        const result = await backfill({ requestPermission: true, reason: "手动补齐" });
        if (result?.saved) button.textContent = `已补齐 ${result.saved} 张`;
        else if (result?.failed) button.textContent = `${result.failed} 张待重试`;
        else button.textContent = "封面已完整";
      } catch (error) {
        button.textContent = "补齐失败";
        log("手动补齐封面失败", error.message || String(error), "error");
        alert(error.message || error);
      } finally {
        setTimeout(() => {
          if (!button.isConnected) return;
          button.disabled = false;
          button.textContent = old;
        }, 2500);
      }
    };
    actions.prepend(button);
  }

  function installObserver() {
    const panel = $("#all-authors-center");
    if (!panel || state.observer) return;
    state.observer = new MutationObserver(() => {
      installButton();
      schedule("下载任务或归档状态变化");
    });
    state.observer.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  function install() {
    installButton();
    installObserver();
  }

  function boot() {
    install();
    new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => backfill({ reason: "页面启动补齐历史遗漏" }).catch(() => {}), 3500);
    state.interval = setInterval(() => {
      const active = $("#aad-tasks .aad-task");
      if (active) schedule("下载进行中定时检查");
    }, 12000);

    window.ARCHIVE_COVER_BACKFILL = {
      version: VERSION,
      run: (requestPermission = true) => backfill({ requestPermission, reason: "控制台手动补齐" }),
      schedule,
      get running() { return state.running; }
    };
    log("封面补齐器已加载：视频文件存在而封面缺失时会自动补齐");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
