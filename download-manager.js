(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const rawFetch = window.__downloadRawFetch || window.fetch.bind(window);
  const STORAGE_KEY = "hq-download-concurrency";
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 16;
  const DEFAULT_CONCURRENCY = 6;

  let activeTask = null;

  const $ = (selector, root = document) => root.querySelector(selector);

  function clampConcurrency(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return DEFAULT_CONCURRENCY;
    return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, number));
  }

  function savedConcurrency() {
    return clampConcurrency(localStorage.getItem(STORAGE_KEY) || DEFAULT_CONCURRENCY);
  }

  function injectStyles() {
    if ($("#download-manager-styles")) return;
    const style = document.createElement("style");
    style.id = "download-manager-styles";
    style.textContent = `
      .download-manager {
        display: grid;
        grid-template-columns: auto minmax(180px, 1fr) auto;
        gap: 10px 14px;
        align-items: center;
        margin: 12px 0 18px;
        padding: 12px 14px;
        border: 1px solid rgba(125, 140, 255, .22);
        border-radius: 12px;
        background: rgba(10, 16, 31, .72);
      }
      .download-manager label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        color: var(--muted, #aab4ce);
        font-size: 13px;
      }
      .download-manager input {
        width: 68px;
        padding: 7px 8px;
        border: 1px solid rgba(125, 140, 255, .28);
        border-radius: 8px;
        color: inherit;
        background: rgba(8, 13, 26, .86);
      }
      .download-manager-status {
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--muted, #aab4ce);
        font-size: 13px;
      }
      .download-manager-progress {
        grid-column: 1 / -1;
        height: 7px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, .08);
      }
      .download-manager-progress > span {
        display: block;
        width: 0;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #7184ff, #55d6be);
        transition: width .16s ease;
      }
      .download-manager button[hidden] { display: none; }
      @media (max-width: 720px) {
        .download-manager { grid-template-columns: 1fr auto; }
        .download-manager-status { grid-column: 1 / -1; }
      }
    `;
    document.head.append(style);
  }

  function ensureUi() {
    injectStyles();
    let manager = $("#download-manager");
    if (manager) return manager;

    manager = document.createElement("div");
    manager.id = "download-manager";
    manager.className = "download-manager";
    manager.innerHTML = `
      <label title="同时发起的分片请求数量；过高可能增加内存和服务器压力">
        下载并发
        <input id="download-concurrency" type="number" min="${MIN_CONCURRENCY}" max="${MAX_CONCURRENCY}" step="1" value="${savedConcurrency()}">
      </label>
      <span class="download-manager-status">下载器空闲 · 域名连续 2 次返回 HTML 404 后将被本次任务禁用</span>
      <button type="button" class="ghost-button download-cancel" hidden>取消下载</button>
      <div class="download-manager-progress" aria-hidden="true"><span></span></div>
    `;

    const library = $(".library-panel");
    const heading = library?.querySelector(".section-heading");
    if (heading) heading.insertAdjacentElement("afterend", manager);
    else document.body.prepend(manager);

    const input = $("#download-concurrency", manager);
    const save = () => {
      const value = clampConcurrency(input.value);
      input.value = String(value);
      localStorage.setItem(STORAGE_KEY, String(value));
    };
    input.addEventListener("change", save);
    input.addEventListener("blur", save);

    $(".download-cancel", manager).addEventListener("click", () => {
      activeTask?.controller.abort("用户取消下载");
    });
    return manager;
  }

  function updateProgress(text, percent = 0, running = true) {
    const manager = ensureUi();
    $(".download-manager-status", manager).textContent = text;
    $(".download-manager-progress > span", manager).style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    $(".download-cancel", manager).hidden = !running;

    const oldWrap = $(".download-progress");
    if (oldWrap) {
      oldWrap.hidden = false;
      const oldLabel = $(".download-progress-text", oldWrap);
      const oldBar = $(".download-progress-bar span", oldWrap);
      if (oldLabel) oldLabel.textContent = text;
      if (oldBar) oldBar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    }
  }

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || "").trim());
      return `${url.protocol}//${url.host}`;
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

  function parseJsonElement(selector) {
    try {
      return JSON.parse($(selector)?.textContent || "");
    } catch {
      return null;
    }
  }

  function resourceOrigins() {
    const values = [];
    const active = $("#active-resource")?.textContent?.trim();
    if (active && active !== "—") values.push(active);

    const domain = parseJsonElement("#domain-json");
    const payload = domain?.decoded?.data || domain?.data || domain?.decoded || domain;
    const domains = payload?.resDomains || payload?.resourceDomains || payload?.resourceUrls || [];
    (Array.isArray(domains) ? domains : [domains]).forEach((value) => values.push(value));
    return unique(values.map(normalizeBase));
  }

  function catalogItems() {
    const catalog = parseJsonElement("#catalog-json");
    const payload = catalog?.decoded?.data || catalog?.data || catalog?.decoded || catalog;
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
      return left.origin === right.origin && normalizePath(left.pathname) === normalizePath(right.pathname) && left.search === right.search;
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
    return String(name || "video")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "video";
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
      if (config.pid && !url.searchParams.has("pid")) url.searchParams.set("pid", config.pid);
      const active = $("#active-resource")?.textContent?.trim();
      if (active && active !== "—" && !url.searchParams.has("domain")) url.searchParams.set("domain", active);
      return url.href;
    } catch {
      return value;
    }
  }

  function bytesToTextPrefix(bytes) {
    return new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 768))).trim().toLowerCase();
  }

  function responseProblem(response, bytes) {
    if (!response.ok) return { kind: "http", message: `HTTP ${response.status}` };
    if (!bytes.length) return { kind: "empty", message: "空响应" };
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const prefix = bytesToTextPrefix(bytes);
    const html404 =
      type.includes("text/html") ||
      prefix.startsWith("<!doctype html") ||
      prefix.startsWith("<html") ||
      /<h1[^>]*>\s*404\s*<\/h1>/.test(prefix);
    if (html404) return { kind: "html404", message: "HTML 404（HTTP 状态可能仍为 200）" };
    if (type.includes("application/json") || prefix.startsWith("{")) {
      return { kind: "json", message: "服务器返回 JSON 而不是媒体分片" };
    }
    return null;
  }

  function createTask(item, concurrency) {
    return {
      item,
      concurrency,
      controller: new AbortController(),
      health: new Map(),
      preferredOrigin: "",
      completed: 0,
      total: 0,
      downloadedBytes: 0,
      startedAt: performance.now()
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
      if (health.html404Streak >= 2) health.disabled = true;
    }
  }

  function disabledOrigins(task) {
    return [...task.health.entries()].filter(([, health]) => health.disabled).map(([origin]) => new URL(origin).host);
  }

  function candidateUrls(task, originalUrl) {
    const original = new URL(originalUrl);
    const origins = unique([
      task.preferredOrigin,
      original.origin,
      ...resourceOrigins()
    ]);
    const result = [];
    for (const origin of origins) {
      if (!origin || healthFor(task, origin).disabled) continue;
      try {
        const url = new URL(origin);
        url.pathname = normalizePath(original.pathname);
        url.search = original.search;
        const href = url.href;
        if (!result.includes(href)) result.push(href);
      } catch {
        // 忽略无效候选地址。
      }
    }
    return result;
  }

  async function fetchMediaBytes(task, originalUrl, label) {
    const errors = [];
    const candidates = candidateUrls(task, originalUrl);
    if (!candidates.length) throw new Error(`${label} 没有可用资源域名`);

    for (const candidate of candidates) {
      const origin = new URL(candidate).origin;
      const health = healthFor(task, origin);
      if (health.disabled) continue;
      try {
        const response = await rawFetch(candidate, {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          signal: task.controller.signal
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const problem = responseProblem(response, bytes);
        if (!problem) {
          recordSuccess(task, origin);
          return { bytes, url: candidate, origin };
        }
        recordFailure(task, origin, problem);
        errors.push(`${new URL(candidate).host}: ${problem.message}`);
        if (healthFor(task, origin).disabled) {
          console.warn(`[download] 已禁用 ${origin}：连续 2 次返回 HTML 404`);
        }
      } catch (error) {
        if (task.controller.signal.aborted) throw new DOMException("下载已取消", "AbortError");
        const problem = { kind: "network", message: error?.message || String(error) };
        recordFailure(task, origin, problem);
        errors.push(`${new URL(candidate).host}: ${problem.message}`);
      }
    }
    throw new Error(`${label} 所有资源线路均失败：${errors.join("；")}`);
  }

  async function fetchPlaylistText(url, signal) {
    const response = await rawFetch(withPlaybackParams(url), {
      headers: { m: "1" },
      cache: "no-store",
      credentials: "omit",
      signal
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const problem = responseProblem(response, bytes);
    if (problem) throw new Error(`m3u8 ${problem.message}`);
    try {
      const inflated = pako.inflate(bytes, { to: "string" });
      if (inflated.includes("#EXTM3U")) return inflated;
    } catch {
      // 继续尝试普通文本。
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("服务器没有返回有效 m3u8");
    return text;
  }

  function parseAttributeList(value) {
    const result = {};
    String(value || "").replace(/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi, (_all, key, raw) => {
      result[key.toUpperCase()] = String(raw || "").replace(/^"|"$/g, "");
      return _all;
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
      if (next < lines.length) {
        variants.push({ bandwidth: Number(attrs.BANDWIDTH || 0), url: new URL(lines[next].trim(), baseUrl).href });
      }
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
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        sequence = Number(line.split(":")[1] || 0);
      } else if (line.startsWith("#EXT-X-KEY:")) {
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

  function taskStatus(task) {
    const preferred = task.preferredOrigin ? new URL(task.preferredOrigin).host : "探测中";
    const disabled = disabledOrigins(task);
    const disabledText = disabled.length ? ` · 已禁用 ${disabled.join(", ")}` : "";
    return `并发 ${task.concurrency} · 完成 ${task.completed}/${task.total} · 当前 ${preferred}${disabledText}`;
  }

  async function tryDirectMp4(task) {
    const video = videoOf(task.item);
    const path = video.mp4PlayURL || video.mp4PlayUrl || "";
    if (!path) return false;
    const candidates = /^https?:\/\//i.test(path)
      ? [path]
      : resourceOrigins().map((origin) => new URL(String(path).replace(/^\/+/, ""), `${origin}/`).href);
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
    const signedUrl = withPlaybackParams(task.item?.url || video.url || "");
    if (!signedUrl) throw new Error("没有 HLS 播放地址");

    updateProgress("正在读取 HLS 播放列表…", 2, true);
    const playlist = await resolveMediaPlaylist(signedUrl, task.controller.signal);
    const parsed = parseMediaPlaylist(playlist.text, playlist.url);
    if (!parsed.segments.length) throw new Error("播放列表中没有视频分片");

    task.total = parsed.segments.length;
    const chunks = new Array(parsed.segments.length + (parsed.initUrl ? 1 : 0));
    const offset = parsed.initUrl ? 1 : 0;

    if (parsed.initUrl) {
      const initResult = await fetchMediaBytes(task, parsed.initUrl, "初始化分片");
      chunks[0] = initResult.bytes;
      task.downloadedBytes += initResult.bytes.byteLength;
    }

    // 先串行探测第一个分片。成功线路会成为 preferredOrigin，随后所有 worker
    // 优先使用它，避免并发启动时同时向已知失效节点发出大量请求。
    const first = parsed.segments[0];
    const firstResult = await fetchMediaBytes(task, first.url, "分片 1");
    chunks[offset] = await decryptSegment(firstResult.bytes, first.key, first.sequence);
    task.downloadedBytes += firstResult.bytes.byteLength;
    task.completed = 1;
    updateProgress(taskStatus(task), 5 + (task.completed / task.total) * 90, true);

    let nextIndex = 1;
    let fatalError = null;
    const worker = async () => {
      while (!fatalError && !task.controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= parsed.segments.length) return;
        const segment = parsed.segments[index];
        try {
          const result = await fetchMediaBytes(task, segment.url, `分片 ${index + 1}`);
          chunks[offset + index] = await decryptSegment(result.bytes, segment.key, segment.sequence);
          task.downloadedBytes += result.bytes.byteLength;
          task.completed += 1;
          updateProgress(taskStatus(task), 5 + (task.completed / task.total) * 90, true);
        } catch (error) {
          fatalError = error;
          task.controller.abort(error?.message || "下载失败");
          throw error;
        }
      }
    };

    const workerCount = Math.min(task.concurrency, Math.max(1, parsed.segments.length - 1));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (fatalError) throw fatalError;

    const extension = parsed.initUrl ? "mp4" : "ts";
    const mime = parsed.initUrl ? "video/mp4" : "video/mp2t";
    const blob = new Blob(chunks, { type: mime });
    triggerBlobDownload(blob, `${sanitizeFilename(video.name)}.${extension}`);
    const seconds = Math.max(0.1, (performance.now() - task.startedAt) / 1000);
    const speed = task.downloadedBytes / 1024 / 1024 / seconds;
    updateProgress(`下载完成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB · 平均 ${speed.toFixed(1)} MB/s`, 100, false);
  }

  async function startDownload(item) {
    if (!item) {
      updateProgress("下载失败：没有找到当前视频数据", 0, false);
      return;
    }
    if (activeTask) {
      updateProgress("已有下载任务正在运行；可先点击“取消下载”", 0, true);
      return;
    }

    const concurrency = clampConcurrency($("#download-concurrency", ensureUi())?.value || savedConcurrency());
    localStorage.setItem(STORAGE_KEY, String(concurrency));
    const task = createTask(item, concurrency);
    activeTask = task;
    try {
      if (await tryDirectMp4(task)) return;
      await downloadHls(task);
    } catch (error) {
      const cancelled = task.controller.signal.aborted && (error?.name === "AbortError" || String(task.controller.signal.reason || "").includes("取消"));
      updateProgress(cancelled ? "下载已取消" : `下载失败：${error?.message || String(error)}`, 0, false);
    } finally {
      activeTask = null;
    }
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.(".card-download, .detail-download-button");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    startDownload(itemForTrigger(trigger));
  }, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureUi, { once: true });
  else ensureUi();
})();
