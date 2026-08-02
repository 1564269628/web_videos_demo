(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const rawFetch = window.__lineSelectorRawFetch || window.__downloadRawFetch || window.__nativeFetch || window.fetch.bind(window);
  const STORAGE_KEY = "hq-download-concurrency";
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 16;
  const DEFAULT_CONCURRENCY = 6;
  const HTML_404_LIMIT = 2;
  const MAX_SEGMENT_ATTEMPTS = 4;
  const MAX_PLAYLIST_REFRESHES = 3;

  const $ = (selector, root = document) => root.querySelector(selector);
  let activeTask = null;

  class MediaResponseError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "MediaResponseError";
      this.refreshable = Boolean(options.refreshable);
      this.rateLimited = Boolean(options.rateLimited);
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

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function normalizeOrigin(value) {
    try {
      const url = new URL(String(value || "").trim());
      return /^https?:$/.test(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  }

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function normalizePath(pathname) {
    return `/${String(pathname || "").replace(/^\/+/, "").replace(/\/{2,}/g, "/")}`;
  }

  function parseJsonElement(selector) {
    try {
      return JSON.parse($(selector)?.textContent || "");
    } catch {
      return null;
    }
  }

  function domainPayload() {
    const value = parseJsonElement("#domain-json");
    return value?.decoded?.data || value?.data || value?.decoded || value || {};
  }

  function resourceOrigins() {
    const values = [];
    const manual = window.LINE_SELECTOR?.selectedResource?.() || localStorage.getItem("hq-manual-resource") || "";
    const active = $("#active-resource")?.textContent?.trim() || "";
    const payload = domainPayload();
    const domains = payload.resDomains || payload.resourceDomains || payload.resourceUrls || [];
    if (manual) values.push(manual);
    if (active && active !== "—" && !active.includes("未下发")) values.push(active);
    (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    return unique(values.map(normalizeOrigin));
  }

  function currentBusinessApi() {
    return normalizeBase(window.LINE_SELECTOR?.selectedApi?.() || $("#active-api")?.textContent || "");
  }

  function currentPlayApi() {
    return normalizeBase(window.LINE_SELECTOR?.selectedPlayApi?.() || localStorage.getItem("hq-manual-play-api") || "");
  }

  function catalogItems() {
    const value = parseJsonElement("#catalog-json");
    const payload = value?.decoded?.data || value?.data || value?.decoded || value || {};
    const list = payload.videoInfo || payload.videos || payload.items || [];
    return Array.isArray(list) ? list : [];
  }

  function videoOf(item) {
    return item?.video && typeof item.video === "object" ? item.video : item || {};
  }

  function videoId(item) {
    const video = videoOf(item);
    return String(video.id ?? video.videoId ?? video.vid ?? item?.id ?? "");
  }

  function sameUrl(leftValue, rightValue) {
    try {
      const left = new URL(leftValue);
      const right = new URL(rightValue);
      return left.pathname === right.pathname && left.search === right.search;
    } catch {
      return String(leftValue || "") === String(rightValue || "");
    }
  }

  function itemForTrigger(trigger) {
    const items = catalogItems();
    const cardId = trigger.closest(".video-card")?.dataset.videoId || "";
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
    const hit = items.find((item) => String(videoOf(item).name || videoOf(item).title || "").trim() === title);
    if (hit) return hit;
    return nowUrl && nowUrl !== "—" ? { video: { name: title || "video" }, url: nowUrl } : null;
  }

  function sanitizeFilename(name) {
    return String(name || "video")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "video";
  }

  function injectStyles() {
    if ($("#download-manager-v3-styles")) return;
    const style = document.createElement("style");
    style.id = "download-manager-v3-styles";
    style.textContent = `
      .download-manager{display:grid;grid-template-columns:auto minmax(220px,1fr) auto;gap:10px 14px;align-items:center;margin:12px 0 18px;padding:12px 14px;border:1px solid rgba(125,140,255,.22);border-radius:12px;background:rgba(10,16,31,.72)}
      .download-manager label{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;color:var(--muted,#aab4ce);font-size:13px}
      .download-manager input{width:68px;padding:7px 8px;border:1px solid rgba(125,140,255,.28);border-radius:8px;color:inherit;background:rgba(8,13,26,.86)}
      .download-manager-status{min-width:0;overflow-wrap:anywhere;color:var(--muted,#aab4ce);font-size:13px;line-height:1.5}
      .download-manager-progress{grid-column:1/-1;height:7px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.08)}
      .download-manager-progress>span{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#7184ff,#55d6be);transition:width .16s ease}
      .download-manager button[hidden]{display:none}
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
      const heading = $(".library-panel .section-heading");
      if (heading) heading.insertAdjacentElement("afterend", manager);
      else document.body.prepend(manager);
    }

    if (!manager.dataset.ready) {
      manager.className = "download-manager";
      manager.innerHTML = `
        <label title="同时下载的分片数量">
          下载并发
          <input id="download-concurrency" type="number" min="${MIN_CONCURRENCY}" max="${MAX_CONCURRENCY}" step="1" value="${savedConcurrency()}">
        </label>
        <span class="download-manager-status">下载器空闲 · 直接使用 HLS，不尝试 MP4</span>
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
      manager.dataset.ready = "1";
    }
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

  function decodeText(bytes, limit = bytes.length) {
    return new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, limit))).replace(/\0/g, "").trim();
  }

  function summarizeJson(value) {
    const code = value?.errorCode ?? value?.code ?? value?.status ?? value?.errCode;
    const message = value?.message ?? value?.msg ?? value?.error ?? value?.detail;
    if (code !== undefined || message !== undefined) return [code !== undefined ? `code=${code}` : "", message !== undefined ? String(message) : ""].filter(Boolean).join(" · ");
    try { return JSON.stringify(value).slice(0, 240); } catch { return "JSON 响应"; }
  }

  function inspectResponse(response, bytes) {
    if (!response.ok) {
      const refreshable = [401, 403, 410, 429].includes(response.status);
      return { kind: "http", message: `HTTP ${response.status}`, refreshable, rateLimited: response.status === 429 };
    }
    if (!bytes.length) return { kind: "empty", message: "空响应", refreshable: true, rateLimited: false };

    const type = String(response.headers.get("content-type") || "").toLowerCase();
    const prefix = decodeText(bytes, 1024).toLowerCase();
    if (type.includes("text/html") || prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || /<h1[^>]*>\s*404\s*<\/h1>/.test(prefix)) {
      return { kind: "html404", message: "HTML 404（HTTP 状态可能仍为 200）", refreshable: false, rateLimited: false };
    }

    const maybeJson = type.includes("application/json") || (bytes.length <= 65536 && (prefix.startsWith("{") || prefix.startsWith("[")));
    if (maybeJson) {
      try {
        const parsed = JSON.parse(decodeText(bytes));
        const summary = summarizeJson(parsed);
        const text = `${summary} ${decodeText(bytes, 1024)}`.toLowerCase();
        return {
          kind: "json",
          message: `JSON：${summary}`,
          refreshable: true,
          rateLimited: /too many|rate|limit|频繁|过快|429|请求过多/.test(text)
        };
      } catch {
        // 只有真正可解析的 JSON 才判定为错误；加密分片可能偶然以“{”或“[”开头。
      }
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
      initUrl: "",
      chunks: [],
      offset: 0
    };
  }

  function healthFor(task, origin) {
    let health = task.health.get(origin);
    if (!health) {
      health = { html404Streak: 0, disabled: false, successes: 0, failures: 0 };
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
      if (health.html404Streak >= HTML_404_LIMIT) health.disabled = true;
    }
  }

  function disabledOrigins(task) {
    return [...task.health.entries()]
      .filter(([, health]) => health.disabled)
      .map(([origin]) => new URL(origin).host);
  }

  function candidateUrls(task, originalUrl) {
    const original = new URL(originalUrl);
    const origins = unique([task.preferredOrigin, ...resourceOrigins(), original.origin]);
    const result = [];
    for (const origin of origins) {
      if (!origin || healthFor(task, origin).disabled) continue;
      const url = new URL(origin);
      url.pathname = normalizePath(original.pathname);
      url.search = original.search;
      if (!result.includes(url.href)) result.push(url.href);
    }
    return result;
  }

  async function fetchMediaBytes(task, originalUrl, label) {
    const errors = [];
    let refreshable = false;
    let rateLimited = false;
    const candidates = candidateUrls(task, originalUrl);
    if (!candidates.length) throw new MediaResponseError(`${label} 没有可用资源线路`);

    for (const candidate of candidates) {
      const origin = new URL(candidate).origin;
      if (healthFor(task, origin).disabled) continue;
      try {
        const response = await rawFetch(candidate, {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          signal: task.controller.signal
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const problem = inspectResponse(response, bytes);
        if (!problem) {
          recordSuccess(task, origin);
          return { bytes, origin, url: candidate };
        }
        recordFailure(task, origin, problem);
        refreshable ||= Boolean(problem.refreshable);
        rateLimited ||= Boolean(problem.rateLimited);
        errors.push(`${new URL(candidate).host}: ${problem.message}`);
      } catch (error) {
        if (task.controller.signal.aborted) throw new DOMException("下载已取消", "AbortError");
        errors.push(`${new URL(candidate).host}: ${error?.message || String(error)}`);
      }
    }

    throw new MediaResponseError(`${label} 所有资源线路均失败：${errors.join("；")}`, { refreshable, rateLimited });
  }

  async function fetchPlaylistText(url, signal) {
    const response = await rawFetch(withPlaybackParams(url), {
      headers: { m: "1" },
      cache: "no-store",
      credentials: "omit",
      signal
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const problem = inspectResponse(response, bytes);
    if (problem) throw new MediaResponseError(`m3u8 ${problem.message}`, problem);
    try {
      const inflated = pako.inflate(bytes, { to: "string" });
      if (inflated.includes("#EXTM3U")) return inflated;
    } catch {
      // 普通文本播放列表。
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("服务器没有返回有效 m3u8");
    return text;
  }

  function parseAttributes(value) {
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
      const attrs = parseAttributes(lines[index].slice(lines[index].indexOf(":") + 1));
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
        const attrs = parseAttributes(line.split(":").slice(1).join(":"));
        key = { method: attrs.METHOD || "NONE", iv: attrs.IV || "" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.split(":").slice(1).join(":"));
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
    const decrypted = CryptoJS.AES.decrypt(body.data, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
    return { ...body, data: JSON.parse(pako.inflate(base64ToBytes(compressedBase64), { to: "string" })) };
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

    const initialPage = currentPage();
    const pageSize = Math.max(10, Number(config.defaultVideoParams?.pageSize || 10));
    const category = $("#category-select")?.value || localStorage.getItem(config.storageKeys?.categoryId || "hq-video-category-id") || "";
    const pages = unique([initialPage, 1, initialPage - 1, initialPage + 1].filter((page) => page > 0));

    for (const page of pages) {
      const url = new URL(config.videoCatalogPath || "videos/short", api);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(Math.max(pageSize, 30)));
      if (category) url.searchParams.set("categorieId", category);
      url.searchParams.set("pid", config.pid || "PH");
      const response = await rawFetch(url.href, {
        headers: apiHeaders(),
        cache: "no-store",
        credentials: "omit",
        signal: task.controller.signal
      });
      if (!response.ok) continue;
      const decoded = decryptEnvelope(JSON.parse(await response.text()));
      if (Number(decoded?.errorCode || 0) !== 0) continue;
      const list = decoded?.data?.videoInfo || [];
      const fresh = list.find((item) => videoId(item) === id);
      if (fresh?.url) return fresh;
    }
    throw new Error("刷新后的列表中没有找到当前视频");
  }

  async function loadPlaylistIntoTask(task, item) {
    const video = videoOf(item);
    const signedUrl = item?.url || video.url || "";
    if (!signedUrl) throw new Error("没有 HLS 播放地址");
    const playlist = await resolveMediaPlaylist(signedUrl, task.controller.signal);
    const parsed = parseMediaPlaylist(playlist.text, playlist.url);
    if (!parsed.segments.length) throw new Error("播放列表中没有视频分片");
    task.item = item;
    task.segments = parsed.segments;
    task.initUrl = parsed.initUrl;
  }

  function taskStatus(task, extra = "") {
    const preferred = task.preferredOrigin ? new URL(task.preferredOrigin).host : "探测中";
    const disabled = disabledOrigins(task);
    const disabledText = disabled.length ? ` · 已禁用 ${disabled.join(", ")}` : "";
    const refreshText = task.refreshCount ? ` · 已刷新 ${task.refreshCount} 次` : "";
    return `并发 ${task.currentLimit}/${task.initialConcurrency} · 完成 ${task.completed}/${task.total} · 当前 ${preferred}${disabledText}${refreshText}${extra ? ` · ${extra}` : ""}`;
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

  async function refreshPlaylist(task, cause) {
    if (task.refreshPromise) return task.refreshPromise;
    if (task.refreshCount >= MAX_PLAYLIST_REFRESHES) throw cause;
    task.refreshPromise = (async () => {
      task.refreshCount += 1;
      task.currentLimit = cause?.rateLimited
        ? Math.max(1, Math.floor(task.currentLimit / 2))
        : Math.max(2, Math.floor(task.currentLimit * 0.75));
      updateProgress(taskStatus(task, `正在刷新播放地址：${cause.message.slice(0, 180)}`), 5 + (task.completed / Math.max(1, task.total)) * 90, true);
      await sleep(cause?.rateLimited ? 1600 : 600, task.controller.signal);
      const oldTotal = task.segments.length;
      const fresh = await refreshCatalogItem(task);
      await loadPlaylistIntoTask(task, fresh);
      if (oldTotal && task.segments.length !== oldTotal) {
        throw new Error(`刷新后的分片数量变化：${oldTotal} → ${task.segments.length}`);
      }
    })().finally(() => { task.refreshPromise = null; });
    return task.refreshPromise;
  }

  async function downloadSegmentWithRetry(task, index) {
    for (let attempt = 1; attempt <= MAX_SEGMENT_ATTEMPTS; attempt += 1) {
      const segment = task.segments[index];
      if (!segment) throw new Error(`刷新后缺少分片 ${index + 1}`);
      try {
        const result = await fetchMediaBytes(task, segment.url, `分片 ${index + 1}`);
        return {
          bytes: await decryptSegment(result.bytes, segment.key, segment.sequence),
          rawSize: result.bytes.byteLength
        };
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
    updateProgress(`下载完成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB · 平均 ${speed.toFixed(1)} MB/s · 刷新 ${task.refreshCount} 次`, 100, false);
  }

  async function startDownload(item) {
    if (!item) return updateProgress("下载失败：没有找到当前视频数据", 0, false);
    if (activeTask) return updateProgress("已有下载任务正在运行；可先取消当前任务", 0, true);
    const concurrency = clampConcurrency($("#download-concurrency", ensureUi())?.value || savedConcurrency());
    localStorage.setItem(STORAGE_KEY, String(concurrency));
    const task = createTask(item, concurrency);
    activeTask = task;
    try {
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
