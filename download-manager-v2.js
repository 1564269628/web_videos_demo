(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const rawFetch = window.__lineSelectorRawFetch || window.__downloadRawFetch || window.fetch.bind(window);
  const STORAGE_KEY = "hq-download-concurrency";
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 16;
  const DEFAULT_CONCURRENCY = 6;
  const MAX_PLAYLIST_REFRESHES = 3;
  const MAX_SEGMENT_ATTEMPTS = 4;

  let activeTask = null;
  const $ = (selector, root = document) => root.querySelector(selector);

  class MediaResponseError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "MediaResponseError";
      this.refreshable = Boolean(options.refreshable);
      this.rateLimited = Boolean(options.rateLimited);
      this.details = options.details || [];
    }
  }

  function clampConcurrency(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return DEFAULT_CONCURRENCY;
    return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, number));
  }

  function savedConcurrency() {
    return clampConcurrency(localStorage.getItem(STORAGE_KEY) || DEFAULT_CONCURRENCY);
  }

  function injectStyles() {
    if ($("#download-manager-v2-styles")) return;
    const style = document.createElement("style");
    style.id = "download-manager-v2-styles";
    style.textContent = `
      .download-manager { display:grid; grid-template-columns:auto minmax(220px,1fr) auto; gap:10px 14px; align-items:center; margin:12px 0 18px; padding:12px 14px; border:1px solid rgba(125,140,255,.22); border-radius:12px; background:rgba(10,16,31,.72); }
      .download-manager label { display:inline-flex; align-items:center; gap:8px; white-space:nowrap; color:var(--muted,#aab4ce); font-size:13px; }
      .download-manager input { width:68px; padding:7px 8px; border:1px solid rgba(125,140,255,.28); border-radius:8px; color:inherit; background:rgba(8,13,26,.86); }
      .download-manager-status { min-width:0; overflow-wrap:anywhere; color:var(--muted,#aab4ce); font-size:13px; line-height:1.5; }
      .download-manager-progress { grid-column:1/-1; height:7px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.08); }
      .download-manager-progress>span { display:block; width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#7184ff,#55d6be); transition:width .16s ease; }
      .download-manager button[hidden] { display:none; }
      @media(max-width:720px){.download-manager{grid-template-columns:1fr auto}.download-manager-status{grid-column:1/-1}}
    `;
    document.head.append(style);
  }

  function ensureUi() {
    injectStyles();
    let manager = $("#download-manager");
    if (!manager) {
      manager = document.createElement("div");
      manager.id = "download-manager";
      const library = $(".library-panel");
      const heading = library?.querySelector(".section-heading");
      if (heading) heading.insertAdjacentElement("afterend", manager);
      else document.body.prepend(manager);
    }
    manager.className = "download-manager";
    manager.innerHTML = `
      <label title="同时执行的分片请求数量；遇到限流时会自动降低">
        下载并发
        <input id="download-concurrency" type="number" min="${MIN_CONCURRENCY}" max="${MAX_CONCURRENCY}" step="1" value="${savedConcurrency()}">
      </label>
      <span class="download-manager-status">下载器空闲 · JSON 错误会显示正文并尝试刷新播放签名</span>
      <button type="button" class="ghost-button download-cancel" hidden>取消下载</button>
      <div class="download-manager-progress"><span></span></div>`;

    const input = $("#download-concurrency", manager);
    const save = () => {
      const value = clampConcurrency(input.value);
      input.value = String(value);
      localStorage.setItem(STORAGE_KEY, String(value));
    };
    input.addEventListener("change", save);
    input.addEventListener("blur", save);
    $(".download-cancel", manager).addEventListener("click", () => activeTask?.controller.abort("用户取消下载"));
    return manager;
  }

  function updateProgress(text, percent = 0, running = true) {
    const manager = ensureUi();
    $(".download-manager-status", manager).textContent = text;
    $(".download-manager-progress>span", manager).style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    $(".download-cancel", manager).hidden = !running;

    const oldWrap = $(".download-progress");
    if (oldWrap) {
      oldWrap.hidden = false;
      const label = $(".download-progress-text", oldWrap);
      const bar = $(".download-progress-bar span", oldWrap);
      if (label) label.textContent = text;
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    }
  }

  function normalizeBase(value, keepPath = true) {
    try {
      const url = new URL(String(value || "").trim());
      if (!/^https?:$/.test(url.protocol)) return "";
      if (!keepPath) return `${url.protocol}//${url.host}`;
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function normalizePath(pathname) {
    return String(pathname || "/").replace(/\/{2,}/g, "/");
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("下载已取消", "AbortError"));
      }, { once: true });
    });
  }

  function parseJsonElement(selector) {
    try {
      return JSON.parse($(selector)?.textContent || "");
    } catch {
      return null;
    }
  }

  function domainPayload() {
    const domain = parseJsonElement("#domain-json");
    return domain?.decoded?.data || domain?.data || domain?.decoded || domain || {};
  }

  function resourceOrigins() {
    const values = [];
    const manual = window.LINE_SELECTOR?.selectedResource?.() || localStorage.getItem("hq-manual-resource") || "";
    if (manual) values.push(manual);
    const active = $("#active-resource")?.textContent?.trim();
    if (active && active !== "—") values.push(active);
    const domains = domainPayload()?.resDomains || domainPayload()?.resourceDomains || [];
    (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    return unique(values.map((value) => normalizeBase(value, false)));
  }

  function currentBusinessApi() {
    return normalizeBase(window.LINE_SELECTOR?.selectedApi?.() || $("#active-api")?.textContent || "");
  }

  function currentPlayApi() {
    return normalizeBase(window.LINE_SELECTOR?.selectedPlayApi?.() || localStorage.getItem("hq-manual-play-api") || "");
  }

  function catalogItems() {
    const catalog = parseJsonElement("#catalog-json");
    const payload = catalog?.decoded?.data || catalog?.data || catalog?.decoded || catalog || {};
    const list = payload?.videoInfo || payload?.videos || payload?.items || [];
    return Array.isArray(list) ? list : [];
  }

  function videoOf(item) {
    return item?.video && typeof item.video === "object" ? item.video : item || {};
  }

  function videoId(item) {
    const video = videoOf(item);
    return String(video.id ?? video.videoId ?? video.vid ?? item?.id ?? "");
  }

  function sameUrl(a, b) {
    try {
      const left = new URL(a);
      const right = new URL(b);
      return left.pathname === right.pathname && left.search === right.search;
    } catch {
      return String(a || "") === String(b || "");
    }
  }

  function itemForTrigger(trigger) {
    const items = catalogItems();
    const card = trigger.closest(".video-card");
    const cardId = card?.dataset.videoId || "";
    if (cardId) {
      const hit = items.find((item) => videoId(item) === cardId);
      if (hit) return hit;
    }
    const nowUrl = $("#now-url")?.textContent?.trim() || "";
    if (nowUrl && nowUrl !== "—") {
      const hit = items.find((item) => sameUrl(item?.url || videoOf(item).url, nowUrl));
      if (hit) return hit;
    }
    const title = $("#now-title")?.textContent?.trim() || "";
    const byTitle = items.find((item) => String(videoOf(item).name || videoOf(item).title || "").trim() === title);
    if (byTitle) return byTitle;
    if (nowUrl && nowUrl !== "—") return { video: { name: title || "video" }, url: nowUrl };
    return null;
  }

  function sanitizeFilename(name) {
    return String(name || "video").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "video";
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function withPlaybackParams(value) {
    try {
      const url = new URL(value);
      const playApi = currentPlayApi();
      if (playApi && /\/videos\/m3u8\//i.test(url.pathname)) {
        const target = new URL(playApi);
        url.protocol = target.protocol;
        url.host = target.host;
        if (url.searchParams.has("h")) url.searchParams.set("h", target.host);
      }
      if (config.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", config.pid);
      const resource = resourceOrigins()[0];
      if (resource) url.searchParams.set("domain", `${resource}/`);
      return url.href;
    } catch {
      return value;
    }
  }

  function bytesToText(bytes, limit = 1200) {
    return new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, limit))).replace(/\0/g, "").trim();
  }

  function summarizeJson(value) {
    if (!value || typeof value !== "object") return String(value || "JSON 响应");
    const code = value.errorCode ?? value.code ?? value.status ?? value.errCode;
    const message = value.message ?? value.msg ?? value.error ?? value.detail;
    const parts = [];
    if (code !== undefined) parts.push(`code=${code}`);
    if (message !== undefined) parts.push(String(message));
    if (!parts.length) parts.push(JSON.stringify(value).slice(0, 240));
    return parts.join(" · ");
  }

  function responseProblem(response, bytes) {
    if (!response.ok) return { kind: "http", message: `HTTP ${response.status}`, refreshable: response.status === 401 || response.status === 403 || response.status === 410 || response.status === 429, rateLimited: response.status === 429 };
    if (!bytes.length) return { kind: "empty", message: "空响应", refreshable: true };
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const prefix = bytesToText(bytes).toLowerCase();
    if (type.includes("text/html") || prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || /<h1[^>]*>\s*404\s*<\/h1>/.test(prefix)) {
      return { kind: "html404", message: "HTML 404（HTTP 状态可能仍为 200）", refreshable: false };
    }
    const looksJson = type.includes("application/json") || prefix.startsWith("{") || prefix.startsWith("[");
    if (looksJson) {
      let parsed = null;
      try { parsed = JSON.parse(bytesToText(bytes, 8192)); } catch { }
      const summary = parsed ? summarizeJson(parsed) : bytesToText(bytes, 500);
      const text = `${summary} ${bytesToText(bytes, 500)}`.toLowerCase();
      const rateLimited = /too many|rate|limit|频繁|过快|429|请求过多/.test(text);
      return { kind: "json", message: `JSON：${summary}`, refreshable: true, rateLimited, json: parsed };
    }
    return null;
  }

  function createTask(item, concurrency) {
    return {
      item,
      initialConcurrency: concurrency,
      currentLimit: concurrency,
      controller: new AbortController(),
      health: new Map(),
      preferredOrigin: resourceOrigins()[0] || "",
      completed: 0,
      total: 0,
      downloadedBytes: 0,
      startedAt: performance.now(),
      refreshCount: 0,
      refreshPromise: null,
      segments: [],
      playlistUrl: "",
      initUrl: "",
      chunks: [],
      offset: 0
    };
  }

  function healthFor(task, origin) {
    let health = task.health.get(origin);
    if (!health) {
      health = { html404Streak: 0, disabled: false, successes: 0, failures: 0, jsonFailures: 0 };
      task.health.set(origin, health);
    }
    return health;
  }

  function recordSuccess(task, origin) {
    const health = healthFor(task, origin);
    health.html404Streak = 0;
    health.successes += 1;
    task.preferredOrigin = origin;
  }

  function recordFailure(task, origin, problem) {
    const health = healthFor(task, origin);
    health.failures += 1;
    if (problem.kind === "html404") {
      health.html404Streak += 1;
      if (health.html404Streak >= 2) health.disabled = true;
    }
    if (problem.kind === "json") health.jsonFailures += 1;
  }

  function disabledOrigins(task) {
    return [...task.health.entries()].filter(([, value]) => value.disabled).map(([origin]) => new URL(origin).host);
  }

  function candidateUrls(task, originalUrl) {
    const original = new URL(originalUrl);
    const origins = unique([task.preferredOrigin, ...resourceOrigins(), original.origin]);
    const result = [];
    for (const origin of origins) {
      if (!origin || healthFor(task, origin).disabled) continue;
      try {
        const url = new URL(origin);
        url.pathname = normalizePath(original.pathname);
        url.search = original.search;
        if (!result.includes(url.href)) result.push(url.href);
      } catch { }
    }
    return result;
  }

  async function fetchMediaBytes(task, originalUrl, label) {
    const errors = [];
    let sawRefreshable = false;
    let sawRateLimit = false;
    const candidates = candidateUrls(task, originalUrl);
    if (!candidates.length) throw new MediaResponseError(`${label} 没有可用资源域名`);

    for (const candidate of candidates) {
      const origin = new URL(candidate).origin;
      if (healthFor(task, origin).disabled) continue;
      try {
        const response = await rawFetch(candidate, { method: "GET", cache: "no-store", credentials: "omit", signal: task.controller.signal });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const problem = responseProblem(response, bytes);
        if (!problem) {
          recordSuccess(task, origin);
          return { bytes, url: candidate, origin };
        }
        recordFailure(task, origin, problem);
        sawRefreshable ||= Boolean(problem.refreshable);
        sawRateLimit ||= Boolean(problem.rateLimited);
        errors.push(`${new URL(candidate).host}: ${problem.message}`);
      } catch (error) {
        if (task.controller.signal.aborted) throw new DOMException("下载已取消", "AbortError");
        errors.push(`${new URL(candidate).host}: ${error?.message || String(error)}`);
      }
    }

    throw new MediaResponseError(`${label} 所有资源线路均失败：${errors.join("；")}`, {
      refreshable: sawRefreshable,
      rateLimited: sawRateLimit,
      details: errors
    });
  }

  async function fetchPlaylistText(url, signal) {
    const response = await rawFetch(withPlaybackParams(url), { headers: { m: "1" }, cache: "no-store", credentials: "omit", signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const problem = responseProblem(response, bytes);
    if (problem) throw new MediaResponseError(`m3u8 ${problem.message}`, { refreshable: problem.refreshable, rateLimited: problem.rateLimited });
    try {
      const inflated = pako.inflate(bytes, { to: "string" });
      if (inflated.includes("#EXTM3U")) return inflated;
    } catch { }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("服务器没有返回有效 m3u8");
    return text;
  }

  function parseAttributeList(value) {
    const result = {};
    String(value || "").replace(/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi, (all, key, raw) => {
      result[key.toUpperCase()] = String(raw || "").replace(/^"|"$/g, "");
      return all;
    });
    return result;
  }

  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = parseAttributeList(lines[index].slice(lines[index].indexOf(":") + 1));
      let next = index + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].startsWith("#"))) next += 1;
      if (next < lines.length) variants.push({ bandwidth: Number(attrs.BANDWIDTH || 0), url: new URL(lines[next].trim(), baseUrl).href });
    }
    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  async function resolveMediaPlaylist(url, signal) {
    let current = withPlaybackParams(url);
    for (let depth = 0; depth < 3; depth += 1) {
      const text = await fetchPlaylistText(current, signal);
      const variants = parseMasterPlaylist(text, current);
      if (!variants.length) return { url: current, text };
      current = variants[0].url;
    }
    throw new Error("HLS 主播放列表嵌套过深");
  }

  function parseMediaPlaylist(text, sourceUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let sequence = 0;
    let key = null;
    let initUrl = "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(line.split(":")[1] || 0);
      else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
        key = { method: attrs.METHOD || "NONE", iv: attrs.IV || "" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
        if (attrs.URI) initUrl = new URL(attrs.URI, sourceUrl).href;
      } else if (!line.startsWith("#")) {
        segments.push({ url: new URL(line, sourceUrl).href, sequence, key: key ? { ...key } : null });
        sequence += 1;
      }
    }
    return { segments, initUrl };
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function parseIv(value, sequence) {
    if (value && /^0x[0-9a-f]+$/i.test(value)) {
      const hex = value.slice(2).padStart(32, "0").slice(-32);
      return Uint8Array.from(hex.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
    }
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sequence >>> 0);
    return iv;
  }

  async function decryptSegment(bytes, keyInfo, sequence) {
    if (!keyInfo || String(keyInfo.method || "NONE").toUpperCase() === "NONE") return bytes;
    if (String(keyInfo.method).toUpperCase() !== "AES-128") throw new Error(`暂不支持 ${keyInfo.method} 加密`);
    const rawKey = base64ToBytes(config.mediaKeyBase64);
    const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: parseIv(keyInfo.iv, sequence) }, cryptoKey, bytes);
    return new Uint8Array(decrypted);
  }

  function decryptEnvelope(body) {
    if (!body || typeof body !== "object" || typeof body.data !== "string" || !body.data) return body;
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const decrypted = CryptoJS.AES.decrypt(body.data, key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7, blockSize: 16 });
    const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
    const bytes = base64ToBytes(compressedBase64);
    return { ...body, data: JSON.parse(pako.inflate(bytes, { to: "string" })) };
  }

  function apiHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      t: "2",
      k: "2",
      token: localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "",
      version: String(config.webVersion || "1.2.75")
    };
  }

  function currentPage() {
    const match = String($("#page-label")?.textContent || "").match(/(\d+)/);
    return Number(match?.[1] || config.defaultVideoParams?.page || 1);
  }

  async function refreshCatalogItem(task) {
    const api = currentBusinessApi();
    const id = videoId(task.item);
    if (!api || !id) throw new Error("无法刷新播放地址：缺少 API 或视频 ID");
    const url = new URL(config.videoCatalogPath || "videos/short", api);
    url.searchParams.set("page", String(currentPage()));
    url.searchParams.set("pageSize", String(config.defaultVideoParams?.pageSize || 10));
    const category = $("#category-select")?.value || localStorage.getItem(config.storageKeys?.categoryId || "hq-video-category-id") || "";
    if (category) url.searchParams.set("categorieId", category);
    url.searchParams.set("pid", config.pid || "PH");
    const response = await rawFetch(url.href, { headers: apiHeaders(), cache: "no-store", credentials: "omit", signal: task.controller.signal });
    if (!response.ok) throw new Error(`刷新视频地址 HTTP ${response.status}`);
    const decoded = decryptEnvelope(JSON.parse(await response.text()));
    if (Number(decoded?.errorCode || 0) !== 0) throw new Error(decoded?.message || `刷新视频地址失败 ${decoded?.errorCode}`);
    const list = decoded?.data?.videoInfo || [];
    const fresh = list.find((item) => videoId(item) === id);
    if (!fresh?.url) throw new Error("刷新后的列表中没有找到当前视频");
    return fresh;
  }

  async function loadPlaylistIntoTask(task, item) {
    const video = videoOf(item);
    const signedUrl = item?.url || video.url || "";
    if (!signedUrl) throw new Error("没有 HLS 播放地址");
    const playlist = await resolveMediaPlaylist(signedUrl, task.controller.signal);
    const parsed = parseMediaPlaylist(playlist.text, playlist.url);
    if (!parsed.segments.length) throw new Error("播放列表中没有视频分片");
    task.item = item;
    task.playlistUrl = playlist.url;
    task.segments = parsed.segments;
    task.initUrl = parsed.initUrl;
    return parsed;
  }

  function taskStatus(task, extra = "") {
    const preferred = task.preferredOrigin ? new URL(task.preferredOrigin).host : "探测中";
    const disabled = disabledOrigins(task);
    const disabledText = disabled.length ? ` · 已禁用 ${disabled.join(", ")}` : "";
    const refreshText = task.refreshCount ? ` · 已刷新签名 ${task.refreshCount} 次` : "";
    return `并发 ${task.currentLimit}/${task.initialConcurrency} · 完成 ${task.completed}/${task.total} · 当前 ${preferred}${disabledText}${refreshText}${extra ? ` · ${extra}` : ""}`;
  }

  async function refreshPlaylist(task, cause) {
    if (task.refreshPromise) return task.refreshPromise;
    if (task.refreshCount >= MAX_PLAYLIST_REFRESHES) throw cause;
    task.refreshPromise = (async () => {
      task.refreshCount += 1;
      if (cause?.rateLimited) task.currentLimit = Math.max(1, Math.floor(task.currentLimit / 2));
      else task.currentLimit = Math.max(2, Math.floor(task.currentLimit * 0.75));
      updateProgress(taskStatus(task, `服务器返回 JSON，等待后刷新播放地址：${cause.message.slice(0, 220)}`), 5 + (task.completed / Math.max(1, task.total)) * 90, true);
      await sleep(cause?.rateLimited ? 1800 : 700, task.controller.signal);
      const fresh = await refreshCatalogItem(task);
      const oldTotal = task.segments.length;
      await loadPlaylistIntoTask(task, fresh);
      if (oldTotal && task.segments.length !== oldTotal) {
        throw new Error(`刷新后的分片数量发生变化：${oldTotal} → ${task.segments.length}，为避免文件错序已停止`);
      }
      for (const health of task.health.values()) health.jsonFailures = 0;
      updateProgress(taskStatus(task, "播放签名已刷新，继续未完成分片"), 5 + (task.completed / Math.max(1, task.total)) * 90, true);
    })().finally(() => { task.refreshPromise = null; });
    return task.refreshPromise;
  }

  async function downloadSegmentWithRetry(task, index) {
    for (let attempt = 1; attempt <= MAX_SEGMENT_ATTEMPTS; attempt += 1) {
      const segment = task.segments[index];
      if (!segment) throw new Error(`刷新后缺少分片 ${index + 1}`);
      try {
        const result = await fetchMediaBytes(task, segment.url, `分片 ${index + 1}`);
        const decrypted = await decryptSegment(result.bytes, segment.key, segment.sequence);
        return { bytes: decrypted, rawSize: result.bytes.byteLength };
      } catch (error) {
        if (task.controller.signal.aborted) throw new DOMException("下载已取消", "AbortError");
        if (error instanceof MediaResponseError && error.refreshable && attempt < MAX_SEGMENT_ATTEMPTS) {
          await refreshPlaylist(task, error);
          await sleep(120 * attempt, task.controller.signal);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`分片 ${index + 1} 超过最大重试次数`);
  }

  async function tryDirectMp4(task) {
    const video = videoOf(task.item);
    const path = video.mp4PlayURL || video.mp4PlayUrl || "";
    if (!path) return false;
    const candidates = /^https?:\/\//i.test(path) ? [path] : resourceOrigins().map((origin) => new URL(String(path).replace(/^\/+/, ""), `${origin}/`).href);
    for (const candidate of candidates) {
      try {
        updateProgress("正在尝试直接 MP4…", 1, true);
        const response = await rawFetch(candidate, { cache: "no-store", credentials: "omit", signal: task.controller.signal });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (responseProblem(response, bytes)) continue;
        const blob = new Blob([bytes], { type: response.headers.get("content-type") || "video/mp4" });
        triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.mp4`);
        updateProgress(`MP4 下载已开始 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 100, false);
        return true;
      } catch (error) {
        if (task.controller.signal.aborted) throw error;
      }
    }
    return false;
  }

  async function downloadHls(task) {
    const video = videoOf(task.item);
    updateProgress("正在读取 HLS 播放列表…", 2, true);
    await loadPlaylistIntoTask(task, task.item);
    task.total = task.segments.length;
    task.offset = task.initUrl ? 1 : 0;
    task.chunks = new Array(task.total + task.offset);

    if (task.initUrl) {
      const initResult = await fetchMediaBytes(task, task.initUrl, "初始化分片");
      task.chunks[0] = initResult.bytes;
      task.downloadedBytes += initResult.bytes.byteLength;
    }

    const first = await downloadSegmentWithRetry(task, 0);
    task.chunks[task.offset] = first.bytes;
    task.downloadedBytes += first.rawSize;
    task.completed = 1;
    updateProgress(taskStatus(task), 5 + (task.completed / task.total) * 90, true);

    let nextIndex = 1;
    let fatalError = null;
    const worker = async (workerId) => {
      while (!fatalError && !task.controller.signal.aborted) {
        if (workerId >= task.currentLimit) return;
        const index = nextIndex++;
        if (index >= task.total) return;
        try {
          const result = await downloadSegmentWithRetry(task, index);
          task.chunks[task.offset + index] = result.bytes;
          task.downloadedBytes += result.rawSize;
          task.completed += 1;
          updateProgress(taskStatus(task), 5 + (task.completed / task.total) * 90, true);
        } catch (error) {
          fatalError = error;
          task.controller.abort(error?.message || "下载失败");
          throw error;
        }
      }
    };

    await Promise.all(Array.from({ length: task.initialConcurrency }, (_, index) => worker(index)));
    if (fatalError) throw fatalError;
    if (task.completed !== task.total) throw new Error(`下载不完整：仅完成 ${task.completed}/${task.total}`);

    const extension = task.initUrl ? "mp4" : "ts";
    const mime = task.initUrl ? "video/mp4" : "video/mp2t";
    const blob = new Blob(task.chunks, { type: mime });
    triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.${extension}`);
    const seconds = Math.max(0.1, (performance.now() - task.startedAt) / 1000);
    const speed = task.downloadedBytes / 1024 / 1024 / seconds;
    updateProgress(`下载完成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB · 平均 ${speed.toFixed(1)} MB/s · 刷新签名 ${task.refreshCount} 次`, 100, false);
  }

  async function startDownload(item) {
    if (!item) return updateProgress("下载失败：没有找到当前视频数据", 0, false);
    if (activeTask) return updateProgress("已有下载任务正在运行；可先点击“取消下载”", 0, true);
    const concurrency = clampConcurrency($("#download-concurrency", ensureUi())?.value || savedConcurrency());
    localStorage.setItem(STORAGE_KEY, String(concurrency));
    const task = createTask(item, concurrency);
    activeTask = task;
    try {
      if (await tryDirectMp4(task)) return;
      await downloadHls(task);
    } catch (error) {
      const cancelled = task.controller.signal.aborted && String(task.controller.signal.reason || "").includes("用户取消");
      updateProgress(cancelled ? "下载已取消" : `下载失败：${error?.message || String(error)}`, 0, false);
    } finally {
      activeTask = null;
    }
  }

  function handleDownloadClick(event) {
    const trigger = event.target.closest?.(".card-download, .detail-download-button");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    startDownload(itemForTrigger(trigger));
  }

  function boot() {
    ensureUi();
    document.addEventListener("click", handleDownloadClick, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
