(() => {
  "use strict";

  const VERSION = "20260803-35-direct-cover";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const DB_NAME = "hq-all-authors-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const ROOT_KEY = "archive-root";
  const COVER_FILES = ["cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif"];
  const VIDEO_FILES = ["video.ts", "video.mp4", "video.webm", "video.mkv"];
  const jobs = new Map();

  const $ = (selector, root = document) => root.querySelector(selector);
  const uniq = (values) => [...new Set(values.filter(Boolean))];

  function log(message, details, level = "log") {
    console[level](`[ARCHIVE OPTIMIZER ${VERSION}] ${message}`, details ?? "");
    const output = $("#aad-log");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let suffix = "";
    if (details !== undefined) {
      try { suffix = `\n${JSON.stringify(details, null, 2)}`; }
      catch { suffix = `\n${String(details)}`; }
    }
    output.textContent = `[${time}] [下载优化] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
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

  async function firstExistingFile(directory, names) {
    for (const name of names) {
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        if (file.size > 0) return { name, handle, file };
      } catch {
        // Try the next candidate.
      }
    }
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

  async function writeFile(directory, name, data) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(data); }
    finally { await writable.close(); }
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
    const direct = detectMime(bytes);
    if (direct) return { bytes, type: direct };
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
        // Continue with binary output.
      }
    }

    const decoded = wordArrayToBytes(decrypted);
    const type = detectMime(decoded);
    if (!type) throw new Error("封面解密后不是可识别图片");
    return { bytes: decoded, type };
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
    const active = normalizeBase($("#active-resource")?.textContent || "");
    return uniq([active, ...(Array.isArray(dynamic) ? dynamic : [dynamic])].map(normalizeBase));
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
    for (const url of coverCandidates(path)) {
      try {
        const response = await fetch(url, {
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
        errors.push(`${url}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | ") || "没有可用封面地址");
  }

  function coverPathOf(item, metadata) {
    return item?.coverPath || item?.verticalCoverURL || item?.coverURL || item?.coverUrl ||
      metadata?.coverPath || metadata?.verticalCoverURL || metadata?.coverURL || metadata?.coverUrl || "";
  }

  async function saveCoverForDirectory(directory, item = {}) {
    if (!directory) return { skipped: "no-directory" };
    const id = String(item.id || directory.name || "unknown");
    if (jobs.has(id)) return jobs.get(id);

    const promise = (async () => {
      if (await firstExistingFile(directory, COVER_FILES)) return { skipped: "exists" };
      const video = await firstExistingFile(directory, VIDEO_FILES);
      if (!video) return { skipped: "video-not-finished" };
      const metadata = await readJson(directory, "metadata.json", {});
      const coverPath = coverPathOf(item, metadata);
      if (!coverPath) throw new Error("作品元数据没有封面地址");
      const image = await downloadCover(coverPath);
      const fileName = `cover.${extension(image.type)}`;
      await writeFile(directory, fileName, image.bytes);
      log("视频完成后已直接保存封面", {
        id: item.id || metadata.id || "",
        title: item.title || metadata.title || directory.name,
        videoFile: video.name,
        coverFile: fileName
      });
      return { saved: true, fileName };
    })().catch((error) => {
      log("单个视频封面保存失败", {
        id: item.id || "",
        title: item.title || directory.name,
        error: error.message || String(error)
      }, "warn");
      return { saved: false, error: error.message || String(error) };
    }).finally(() => {
      setTimeout(() => jobs.delete(id), 15000);
    });

    jobs.set(id, promise);
    return promise;
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

  async function getRoot(requestPermission = false) {
    const db = await openDatabase();
    const root = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(ROOT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    }).catch(() => null);
    if (!root) return null;
    try {
      if ((await root.queryPermission({ mode: "readwrite" })) === "granted") return root;
      if (requestPermission && (await root.requestPermission({ mode: "readwrite" })) === "granted") return root;
    } catch {
      return null;
    }
    return null;
  }

  function workFolderName(work) {
    return `${String(work.index || 0).padStart(5, "0")}_${clean(work.title || work.id, work.id || "video", 56)}_${clean(work.id, "id", 32)}`;
  }

  async function findWorkDirectory(worksDirectory, work) {
    try { return await worksDirectory.getDirectoryHandle(workFolderName(work)); }
    catch {
      const id = String(work.id || "").trim();
      if (!id) return null;
      for await (const entry of worksDirectory.values()) {
        if (entry.kind === "directory" && (entry.name.endsWith(`_${id}`) || entry.name.includes(id))) return entry;
      }
      return null;
    }
  }

  async function manualBackfill() {
    const root = await getRoot(true);
    if (!root) throw new Error("请先选择归档总目录");
    const targets = [];
    let downloaded = 0;
    let covered = 0;

    for await (const author of root.values()) {
      if (author.kind !== "directory") continue;
      const works = await readJson(author, "works.json", []);
      if (!Array.isArray(works) || !works.length) continue;
      let worksDirectory;
      try { worksDirectory = await author.getDirectoryHandle("works"); }
      catch { continue; }
      for (let index = 0; index < works.length; index += 1) {
        const raw = works[index]?.video && typeof works[index].video === "object" ? works[index].video : works[index] || {};
        const work = {
          index: Number(works[index]?.index || raw.index || index + 1),
          id: String(raw.id ?? raw.videoId ?? raw.vid ?? works[index]?.id ?? ""),
          title: raw.title || raw.name || "",
          coverPath: raw.coverPath || raw.verticalCoverURL || raw.coverURL || raw.coverUrl || ""
        };
        const directory = await findWorkDirectory(worksDirectory, work);
        if (!directory || !(await firstExistingFile(directory, VIDEO_FILES))) continue;
        downloaded += 1;
        if (await firstExistingFile(directory, COVER_FILES)) {
          covered += 1;
          continue;
        }
        targets.push({ directory, work });
      }
    }

    let cursor = 0;
    let saved = 0;
    let failed = 0;
    const workers = Array.from({ length: Math.min(8, Math.max(1, targets.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) return;
        const result = await saveCoverForDirectory(targets[index].directory, targets[index].work);
        if (result?.saved) saved += 1;
        else if (!result?.skipped) failed += 1;
      }
    });
    await Promise.all(workers);
    const summary = { downloaded, alreadyCovered: covered, missing: targets.length, saved, failed };
    log("手动历史封面补齐完成", summary);
    return summary;
  }

  function installButton() {
    const actions = $("#all-authors-center .aad-header-actions");
    if (!actions || $("#aad-manual-cover-backfill", actions)) return;
    const button = document.createElement("button");
    button.id = "aad-manual-cover-backfill";
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = "手动补齐历史封面";
    button.onclick = async () => {
      const old = button.textContent;
      button.disabled = true;
      button.textContent = "正在扫描历史文件…";
      try {
        const result = await manualBackfill();
        button.textContent = `补齐 ${result.saved} 张`;
      } catch (error) {
        button.textContent = "补齐失败";
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

  function boot() {
    installButton();
    new MutationObserver(installButton).observe(document.documentElement, { childList: true, subtree: true });
    log("下载优化器已加载：不自动扫描目录；每个视频完成后直接保存封面");
  }

  window.ARCHIVE_RUNTIME_OPTIMIZER = {
    version: VERSION,
    directCoverSave: true,
    saveCoverForDirectory,
    manualBackfill,
    installButton
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();