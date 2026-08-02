(() => {
  "use strict";

  const VERSION = "20260802-18";
  const cfg = window.VIDEO_APP_CONFIG || {};
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  const runtime = { running: false, cancelled: false, controller: null, done: new Set(), failed: {}, bytes: 0, authorDir: null };

  const $ = (s, r = document) => r.querySelector(s);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const clean = (s, fallback = "未命名", max = 72) => (String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").replace(/\s+/g, " ").trim() || fallback).slice(0, max);
  const base = (s) => { try { const u = new URL(String(s || "").trim()); return u.href.endsWith("/") ? u.href : `${u.href}/`; } catch { return ""; } };
  const join = (b, p) => new URL(String(p || "").replace(/^\/+/, ""), base(b)).href;
  const videoOf = (item) => item?.video && typeof item.video === "object" ? item.video : item || {};
  const videoId = (item) => String(videoOf(item).id ?? item?.id ?? "");
  const token = () => localStorage.getItem(cfg.storageKeys?.token || "hq-video-token") || "";
  const api = () => base($("#active-api")?.textContent);
  const activeResource = () => base($("#active-resource")?.textContent);

  function log(message, details, level = "log") {
    console[level](`[AUTHOR EXPORT ${VERSION}] ${message}`, details || "");
    const out = $("#log-output");
    if (!out) return;
    const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] [作者归档] ${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}\n`;
    out.textContent = `${line}${out.textContent === "页面启动中…" ? "" : out.textContent || ""}`.slice(0, 120000);
  }

  function b64ToBytes(value) {
    const bin = atob(String(value || "").replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function bytesToB64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    return btoa(out);
  }

  function wordBytes(wordArray) {
    const bytes = new Uint8Array(wordArray?.sigBytes || 0);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
    return bytes;
  }

  function decryptEnvelope(body) {
    if (!body || typeof body.data !== "string" || !body.data) return body;
    const decrypted = CryptoJS.AES.decrypt(body.data, CryptoJS.enc.Utf8.parse(cfg.aesKey), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
    const compressed = CryptoJS.enc.Utf8.stringify(decrypted);
    return { ...body, data: JSON.parse(pako.inflate(b64ToBytes(compressed), { to: "string" })) };
  }

  async function fetchTimed(url, init = {}, timeout = 15000) {
    const controller = new AbortController();
    const parent = runtime.controller?.signal;
    const abort = () => controller.abort(parent?.reason || "cancelled");
    if (parent) parent.aborted ? abort() : parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeout);
    try { return await nativeFetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); parent?.removeEventListener?.("abort", abort); }
  }

  async function apiGet(path, params = {}) {
    if (!api()) throw new Error("API 尚未初始化");
    const url = new URL(join(api(), path));
    Object.entries(params).forEach(([k, v]) => v !== "" && v != null && url.searchParams.set(k, String(v)));
    const response = await fetchTimed(url, { headers: { accept: "application/json", "content-type": "application/json", t: "2", k: "2", token: token(), version: String(cfg.webVersion || "1.2.75") }, cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

  function domains() {
    let dynamic = [];
    try {
      const parsed = JSON.parse($("#domain-json")?.textContent || "{}");
      const data = parsed?.decoded?.data || parsed?.decoded || parsed?.data || parsed;
      dynamic = data?.resDomains || data?.resourceDomains || [];
    } catch { /* ignore */ }
    return uniq([activeResource(), ...(Array.isArray(dynamic) ? dynamic : [dynamic])].map(base));
  }

  function mime(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 12)).includes("ftypavi")) return "image/avif";
    return "";
  }

  const ext = (type) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" })[type] || "bin";

  function decodeImage(bytes) {
    const raw = mime(bytes);
    if (raw) return { bytes, type: raw };
    const decrypted = CryptoJS.AES.decrypt(bytesToB64(bytes), CryptoJS.enc.Utf8.parse(cfg.imageAesKey || "82758dd12749c777ef579f1839ceea6a"), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
    let text = "";
    try { text = CryptoJS.enc.Utf8.stringify(decrypted).replace(/\0+$/g, "").trim(); } catch { text = ""; }
    if (/^data:image\//i.test(text)) {
      const comma = text.indexOf(",");
      return { bytes: b64ToBytes(text.slice(comma + 1)), type: text.slice(5, text.indexOf(";")) || "image/webp" };
    }
    if (text.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try { const decoded = b64ToBytes(text); const type = mime(decoded); if (type) return { bytes: decoded, type }; } catch { /* ignore */ }
    }
    const decoded = wordBytes(decrypted);
    const type = mime(decoded);
    if (!type) throw new Error("图片解密后格式未知");
    return { bytes: decoded, type };
  }

  async function getImage(path, size = 720) {
    const candidates = [];
    for (const d of domains()) {
      const original = join(d, path);
      if (/\.(ceb|geb)(?:$|[?#])/i.test(original)) candidates.push(`${original}@webp-${size}`);
      candidates.push(original);
    }
    const errors = [];
    for (const url of uniq(candidates)) {
      try {
        const response = await fetchTimed(url, { cache: "force-cache", mode: "cors", credentials: "omit" }, 12000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error("空响应");
        return { ...decodeImage(bytes), url };
      } catch (error) { errors.push(`${url}: ${error.message}`); }
    }
    throw new Error(errors.join(" | ") || "无图片线路");
  }

  async function dir(parent, name) { return parent.getDirectoryHandle(clean(name), { create: true }); }
  async function write(directory, name, data) {
    const handle = await directory.getFileHandle(clean(name, "file", 140), { create: true });
    const stream = await handle.createWritable();
    try { await stream.write(data); } finally { await stream.close(); }
    runtime.bytes += data?.byteLength || data?.size || String(data).length;
  }
  const writeJson = (d, n, v) => write(d, n, JSON.stringify(v, null, 2));
  async function readJson(d, n, fallback = {}) { try { return JSON.parse(await (await (await d.getFileHandle(n)).getFile()).text()); } catch { return fallback; } }
  async function exists(d, n) { try { return (await (await d.getFileHandle(n)).getFile()).size > 0; } catch { return false; } }

  function tags(video) {
    return uniq([...(video.videoTags || []), ...(video.tags || []).map((v) => typeof v === "string" ? v : v?.name)].filter(Boolean));
  }

  function normal(item, index) {
    const v = videoOf(item);
    return { index, id: videoId(item), title: v.name || v.title || "", description: v.description || v.introduce || "", tags: tags(v), durationSeconds: Number(v.time || 0), width: Number(v.width || 0), height: Number(v.height || 0), playCount: Number(v.playCnt || 0), likeCount: Number(v.likedCnt || 0), commentCount: Number(v.commentCnt || 0), collectCount: Number(v.collectedCnt || 0), releaseDate: v.releaseDate || "", releaseDateLabel: v.releaseDateLabel || "", categories: v.categories || [], coverPath: v.verticalCoverURL || v.coverURL || "", playPath: v.playURL || "", signedPlaylistUrl: item?.url || v.url || "", rawAuthor: v.user || null };
  }

  function csv(rows) {
    const keys = ["index", "id", "title", "description", "tags", "durationSeconds", "width", "height", "playCount", "likeCount", "commentCount", "collectCount", "releaseDate", "releaseDateLabel", "coverPath", "playPath"];
    const q = (v) => `"${(Array.isArray(v) ? v.join("|") : String(v ?? "")).replace(/"/g, '""')}"`;
    return `\ufeff${keys.join(",")}\n${rows.map((r) => keys.map((k) => q(r[k])).join(",")).join("\n")}\n`;
  }

  function attrs(value) {
    const out = {};
    String(value || "").replace(/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi, (_, k, v) => { out[k.toUpperCase()] = String(v).replace(/^"|"$/g, ""); return _; });
    return out;
  }

  function playbackUrl(value) {
    const url = new URL(value);
    if (cfg.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", cfg.pid);
    if (activeResource() && !url.searchParams.has("domain")) url.searchParams.set("domain", activeResource());
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.href;
  }

  async function playlistText(url) {
    const response = await fetchTimed(playbackUrl(url), { headers: { m: "1" }, cache: "no-store", mode: "cors", credentials: "omit" }, 18000);
    if (!response.ok) throw new Error(`m3u8 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try { const text = pako.inflate(bytes, { to: "string" }); if (text.includes("#EXTM3U")) return text; } catch { /* plain */ }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("无效 m3u8");
    return text;
  }

  async function resolvePlaylist(url) {
    let current = playbackUrl(url);
    for (let depth = 0; depth < 4; depth += 1) {
      const text = await playlistText(current);
      const lines = text.split(/\r?\n/);
      const variants = [];
      for (let i = 0; i < lines.length; i += 1) if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const a = attrs(lines[i].slice(lines[i].indexOf(":") + 1)); let n = i + 1;
        while (n < lines.length && (!lines[n].trim() || lines[n].startsWith("#"))) n += 1;
        if (n < lines.length) variants.push({ bandwidth: Number(a.BANDWIDTH || 0), url: new URL(lines[n].trim(), current).href });
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      if (!variants.length) return { url: current, text };
      current = variants[0].url;
    }
    throw new Error("播放列表嵌套过深");
  }

  function parseMedia(text, source) {
    const segments = []; let sequence = 0; let key = null; let init = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(line.split(":")[1] || 0);
      else if (line.startsWith("#EXT-X-KEY:")) { const a = attrs(line.slice(line.indexOf(":") + 1)); key = { method: a.METHOD || "NONE", iv: a.IV || "" }; }
      else if (line.startsWith("#EXT-X-MAP:")) { const a = attrs(line.slice(line.indexOf(":") + 1)); if (a.URI) init = new URL(a.URI, source).href; }
      else if (!line.startsWith("#")) { segments.push({ url: new URL(line, source).href, sequence, key: key ? { ...key } : null }); sequence += 1; }
    }
    return { segments, init };
  }

  function mediaCandidates(value) {
    const result = [value];
    try {
      const original = new URL(value);
      for (const d of domains()) { const u = new URL(d); u.pathname = original.pathname.replace(/\/{2,}/g, "/"); u.search = original.search; result.push(u.href); }
    } catch { /* ignore */ }
    return uniq(result);
  }

  async function mediaBytes(url) {
    const errors = [];
    for (const candidate of mediaCandidates(url)) {
      try {
        const response = await fetchTimed(candidate, { cache: "no-store", mode: "cors", credentials: "omit" }, 20000);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const head = new TextDecoder().decode(bytes.subarray(0, Math.min(400, bytes.length))).trimStart();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!bytes.length) throw new Error("空响应");
        if (/^<!doctype html|^<html/i.test(head)) throw new Error("HTML 响应");
        if (bytes.length < 16384 && (head.startsWith("{") || head.startsWith("["))) { try { JSON.parse(head); throw new Error("JSON 响应"); } catch (e) { if (e.message === "JSON 响应") throw e; } }
        return bytes;
      } catch (error) { errors.push(`${candidate}: ${error.message}`); }
    }
    throw new Error(errors.join("；"));
  }

  function iv(value, sequence) {
    if (value && /^0x[0-9a-f]+$/i.test(value)) return Uint8Array.from(value.slice(2).padStart(32, "0").slice(-32).match(/.{2}/g).map((x) => parseInt(x, 16)));
    const out = new Uint8Array(16); new DataView(out.buffer).setUint32(12, sequence >>> 0); return out;
  }

  async function decryptSegment(bytes, key, sequence) {
    if (!key || String(key.method).toUpperCase() === "NONE") return bytes;
    if (String(key.method).toUpperCase() !== "AES-128") throw new Error(`不支持 ${key.method}`);
    const cryptoKey = await crypto.subtle.importKey("raw", b64ToBytes(cfg.mediaKeyBase64), { name: "AES-CBC" }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv(key.iv, sequence) }, cryptoKey, bytes));
  }

  async function playable(item) {
    if (item?.url || videoOf(item).url) return item;
    const id = videoId(item); let last;
    for (const path of [`videos/${id}`, `shortVideos/${id}`, `newsVideos/${id}`]) try {
      const result = await apiGet(path, { pid: cfg.pid || "PH" }); const data = result.data || {}; const v = data.video || data; const url = data.url || v.url || v.playURL;
      if (url) return { video: { ...videoOf(item), ...v }, url };
    } catch (error) { last = error; }
    throw last || new Error("没有播放地址");
  }

  async function saveVideo(item, directory, concurrency, progress) {
    const p = await playable(item); const signed = p.url || videoOf(p).url;
    const resolved = await resolvePlaylist(signed); await write(directory, "playlist.m3u8", resolved.text);
    const parsed = parseMedia(resolved.text, resolved.url); if (!parsed.segments.length) throw new Error("没有视频分片");
    const name = parsed.init ? "video.mp4" : "video.ts"; const handle = await directory.getFileHandle(name, { create: true }); const stream = await handle.createWritable(); let countBytes = 0;
    try {
      if (parsed.init) { const b = await mediaBytes(parsed.init); await stream.write(b); countBytes += b.length; }
      for (let start = 0; start < parsed.segments.length; start += concurrency) {
        if (runtime.cancelled) throw new Error("已取消");
        const batch = parsed.segments.slice(start, start + concurrency);
        const chunks = await Promise.all(batch.map(async (s) => decryptSegment(await mediaBytes(s.url), s.key, s.sequence)));
        for (const chunk of chunks) { await stream.write(chunk); countBytes += chunk.length; }
        progress(Math.min(parsed.segments.length, start + batch.length), parsed.segments.length, countBytes);
      }
    } finally { await stream.close(); }
    runtime.bytes += countBytes;
    return { fileName: name, byteLength: countBytes, segmentCount: parsed.segments.length, playlistUrl: resolved.url, completedAt: new Date().toISOString() };
  }

  async function allWorks(uid, status) {
    const path = String(cfg.authorVideosPath || "users/{uid}/videos").replace("{uid}", encodeURIComponent(uid)); const out = []; const seen = new Set();
    for (let page = 1; page <= 10000; page += 1) {
      status(`正在获取作品第 ${page} 页，已发现 ${out.length} 条`);
      const pageItems = findArray((await apiGet(path, { timeType: 3, page, pageSize: 20, pid: cfg.pid || "PH" })).data);
      if (!pageItems.length) break; let added = 0;
      for (const item of pageItems) { const id = videoId(item) || JSON.stringify(item).slice(0, 160); if (!seen.has(id)) { seen.add(id); out.push(item); added += 1; } }
      if (!added || pageItems.length < 20) break;
    }
    return out;
  }

  function panel() {
    let p = $("#author-export-panel"); if (p) return p;
    p = document.createElement("section"); p.id = "author-export-panel"; p.hidden = true;
    p.innerHTML = `<div class="aex-title"><strong>作者完整归档</strong><button type="button">取消</button></div><div class="aex-bar"><span></span></div><p class="aex-status">准备中…</p><p class="aex-stats"></p>`; document.body.append(p);
    p.querySelector("button").onclick = () => { if (runtime.running) { runtime.cancelled = true; runtime.controller?.abort("cancelled"); update("正在取消…"); } };
    const style = document.createElement("style"); style.textContent = `#author-export-panel{position:fixed;right:18px;bottom:18px;z-index:100000;width:min(430px,calc(100vw - 36px));padding:14px;border:1px solid #33415f;border-radius:14px;background:#0f1728;color:#eef2ff;box-shadow:0 20px 60px #0009;font:13px/1.5 system-ui}.aex-title{display:flex;justify-content:space-between;align-items:center}.aex-title button{padding:5px 10px;border:1px solid #465476;border-radius:8px;background:#182238;color:#fff}.aex-bar{height:8px;margin:10px 0;background:#263149;border-radius:99px;overflow:hidden}.aex-bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,#7b6cff,#4fd1c5)}.aex-status,.aex-stats{margin:6px 0;color:#cbd5e1;word-break:break-word}.author-export-button{margin-left:8px;padding:7px 11px;border:0;border-radius:9px;background:#7c5cff;color:#fff}.author-export-button:disabled{opacity:.55}`; document.head.append(style); return p;
  }

  function size(value) { return value >= 1073741824 ? `${(value / 1073741824).toFixed(2)} GB` : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`; }
  function update(text, percent = null, stats = null) { const p = panel(); p.hidden = false; $(".aex-status", p).textContent = text; if (percent != null) $(".aex-bar span", p).style.width = `${Math.max(0, Math.min(100, percent))}%`; if (stats != null) $(".aex-stats", p).textContent = stats; }
  async function saveState(uid, author) { await writeJson(runtime.authorDir, "export-state.json", { version: VERSION, uid, author: author.username, updatedAt: new Date().toISOString(), completed: [...runtime.done], failed: runtime.failed, bytesWritten: runtime.bytes }); }

  async function archive(uid, fallback, root, concurrency) {
    runtime.running = true; runtime.cancelled = false; runtime.controller = new AbortController(); runtime.bytes = 0;
    try {
      update("正在获取作者资料…", 0);
      let rawInfo = null; let author = { uid, username: fallback };
      try { rawInfo = await apiGet(String(cfg.authorInfoPath || "users/{uid}/info").replace("{uid}", uid), { pid: cfg.pid || "PH" }); author = rawInfo.data?.user || rawInfo.data || author; } catch (error) { log("作者资料接口失败，使用页面资料", error.message, "warn"); }
      runtime.authorDir = await dir(root, `${author.username || fallback}_UID${uid}`);
      const previous = await readJson(runtime.authorDir, "export-state.json", {}); runtime.done = new Set(previous.completed || []); runtime.failed = previous.failed || {};
      const assets = await dir(runtime.authorDir, "assets"); const worksDir = await dir(runtime.authorDir, "works");
      await writeJson(runtime.authorDir, "author.raw.json", rawInfo || author);
      await writeJson(runtime.authorDir, "author.json", { id: author.id || "", uid: author.uid ?? uid, username: author.username || fallback, signature: author.introduce || "", videoCount: author.videoCnt ?? null, followerCount: author.followerCnt ?? null, likedCount: author.likedCnt ?? null, collectCount: author.collectCnt ?? null, avatarPath: author.avatarURL || "", backgroundPath: author.bgCoverUrl || "", exportedAt: new Date().toISOString() });
      for (const [name, path, px] of [["avatar", author.avatarURL, 480], ["background", author.bgCoverUrl, 1280]]) if (path) try { const image = await getImage(path, px); await write(assets, `${name}.${ext(image.type)}`, image.bytes); } catch (e) { await write(assets, `${name}-error.txt`, e.message); }
      const works = await allWorks(uid, (m) => update(m, 1)); const normalized = works.map((item, i) => normal(item, i + 1));
      await writeJson(runtime.authorDir, "works.raw.json", works); await writeJson(runtime.authorDir, "works.json", normalized); await write(runtime.authorDir, "works.csv", csv(normalized)); await saveState(uid, author);
      for (let i = 0; i < works.length; i += 1) {
        if (runtime.cancelled) throw new Error("已取消"); const item = works[i]; const v = videoOf(item); const id = videoId(item) || `unknown-${i + 1}`;
        if (runtime.done.has(id)) { update(`跳过已完成 ${i + 1}/${works.length}`, ((i + 1) / works.length) * 100, `已完成 ${runtime.done.size}/${works.length}`); continue; }
        const workDir = await dir(worksDir, `${String(i + 1).padStart(5, "0")}_${clean(v.name || id, id, 56)}_${clean(id, "id", 30)}`);
        try {
          await writeJson(workDir, "metadata.raw.json", item); await writeJson(workDir, "metadata.json", normalized[i]);
          if (normalized[i].coverPath) try { const image = await getImage(normalized[i].coverPath, 720); await write(workDir, `cover.${ext(image.type)}`, image.bytes); } catch (e) { await write(workDir, "cover-error.txt", e.message); }
          if (!(await exists(workDir, "video.ts")) && !(await exists(workDir, "video.mp4"))) {
            const result = await saveVideo(item, workDir, concurrency, (done, total, bytes) => update(`正在下载 ${i + 1}/${works.length}：${v.name || id} · 分片 ${done}/${total}`, ((i + done / total) / works.length) * 100, `本视频 ${size(bytes)} · 总计 ${size(runtime.bytes + bytes)}`));
            await writeJson(workDir, "download.json", result);
          }
          runtime.done.add(id); delete runtime.failed[id]; await saveState(uid, author);
        } catch (error) { runtime.failed[id] = error.message || String(error); await saveState(uid, author); log("单个作品失败，继续下一个", { id, title: v.name, error: runtime.failed[id] }, "warn"); }
      }
      update(Object.keys(runtime.failed).length ? `归档完成，${Object.keys(runtime.failed).length} 个作品失败` : "作者全部数据归档完成", 100, `成功 ${runtime.done.size}/${works.length} · 写入 ${size(runtime.bytes)}`);
    } finally { runtime.running = false; runtime.controller = null; document.querySelectorAll(".author-export-button").forEach((b) => { b.disabled = false; b.textContent = "导出作者全部数据"; }); }
  }

  function install(modal) {
    if (!modal || $(".author-export-button", modal)) return;
    const button = document.createElement("button"); button.type = "button"; button.className = "author-export-button"; button.textContent = "导出作者全部数据"; ($(".author-works-heading", modal) || $(".author-header", modal) || modal).append(button);
    button.onclick = async () => {
      if (runtime.running) return;
      if (typeof showDirectoryPicker !== "function") return alert("请使用最新版 Edge 或 Chrome。当前浏览器不支持直接写入文件夹。");
      const uid = ($(".author-uid", modal)?.textContent || "").match(/\d+/)?.[0]; const name = $(".author-name", modal)?.textContent?.trim() || "未知作者";
      if (!uid) return alert("作者 UID 尚未加载完成。");
      let root; try { root = await showDirectoryPicker({ mode: "readwrite", id: "hq-author-export" }); } catch (e) { if (e.name !== "AbortError") alert(e.message); return; }
      const raw = prompt("每个视频的分片并发数（1～16，建议 6）：", localStorage.getItem("hq-author-export-concurrency") || "6"); if (raw == null) return;
      const concurrency = Math.max(1, Math.min(16, Number(raw) || 6)); localStorage.setItem("hq-author-export-concurrency", String(concurrency));
      if (!confirm(`将把作者“${name}”的头像、资料、全部作品元数据、封面和视频写入所选文件夹。作品多时可能耗时数小时并占用大量空间。\n\n继续吗？`)) return;
      button.disabled = true; button.textContent = "正在导出…";
      archive(uid, name, root, concurrency).catch((error) => { update(runtime.cancelled ? "已取消；重新选择同一文件夹可继续" : `归档失败：${error.message}`, null, `已完成 ${runtime.done.size} · 写入 ${size(runtime.bytes)}`); log("作者归档中止", error.stack || error.message, runtime.cancelled ? "warn" : "error"); });
    };
  }

  const scan = () => install($("#author-modal"));
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  log("作者归档模块已加载", { version: VERSION, fileSystemAccess: typeof showDirectoryPicker === "function" });
})();
