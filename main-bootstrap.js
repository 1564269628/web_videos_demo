(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const rawFetch = window.__nativeFetch || window.fetch.bind(window);
  const STORAGE_KEY = "hq-last-good-api";
  const MANUAL_KEY = "hq-manual-api";
  const PROBE_TIMEOUT_MS = 3200;

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function unique(values) {
    return [...new Set(values.map(normalizeBase).filter(Boolean))];
  }

  function setBadge(text, kind = "busy") {
    const badge = document.querySelector("#connection-badge");
    if (!badge) return;
    badge.textContent = text;
    badge.className = `badge badge-${kind}`;
  }

  function withHardTimeout(promise, milliseconds, controller) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        controller?.abort();
        reject(new Error(`测速超过 ${milliseconds} ms`));
      }, milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  }

  async function probe(base) {
    const controller = new AbortController();
    const started = performance.now();
    const target = new URL(config.speedtestPath || "speedtest", base).href;
    const response = await withHardTimeout(
      rawFetch(target, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }),
      PROBE_TIMEOUT_MS,
      controller
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await withHardTimeout(response.text(), 1200, controller);
    let payload = null;
    try { payload = JSON.parse(text); } catch { }
    if (payload && Number(payload.errorCode ?? 0) !== 0) {
      throw new Error(payload.message || `errorCode ${payload.errorCode}`);
    }
    return { base, elapsed: Math.round(performance.now() - started) };
  }

  async function firstWorking(candidates) {
    return new Promise((resolve, reject) => {
      let pending = candidates.length;
      const errors = [];
      if (!pending) return reject(new Error("没有 API 候选线路"));
      candidates.forEach((base) => {
        probe(base).then(resolve).catch((error) => {
          errors.push(`${base}: ${error?.message || String(error)}`);
          pending -= 1;
          if (!pending) reject(new Error(errors.join("；")));
        });
      });
    });
  }

  async function start() {
    const allCandidates = unique(config.apiCandidates || []);
    config.allApiCandidates = [...allCandidates];

    const manual = normalizeBase(localStorage.getItem(MANUAL_KEY));
    const lastGood = normalizeBase(localStorage.getItem(STORAGE_KEY));
    const ordered = unique([manual, lastGood, ...allCandidates]);

    setBadge("正在快速选择 API…", "busy");

    let winner = null;
    try {
      winner = await firstWorking(ordered);
      localStorage.setItem(STORAGE_KEY, winner.base);
      setBadge(`快速选线完成 · ${winner.elapsed} ms`, "ok");
    } catch (error) {
      const fallback = manual || lastGood || ordered.find((item) => item.includes("fall.faj135.com")) || ordered[0] || "";
      if (!fallback) throw error;
      winner = { base: fallback, elapsed: null };
      console.warn("快速选线全部失败，使用备用线路", error);
      setBadge("快速测速失败，尝试备用 API…", "busy");
    }

    config.apiCandidates = [winner.base];
    config.useDynamicApiDomains = false;
    await import(`./app.js?v=20260802-14`);
  }

  start().catch((error) => {
    console.error("main-bootstrap", error);
    setBadge(`启动失败：${error?.message || String(error)}`, "error");
    const list = document.querySelector("#video-list");
    if (list) list.innerHTML = `<div class="empty-list">启动失败：${String(error?.message || error).replace(/[<>]/g, "")}</div>`;
  });
})();