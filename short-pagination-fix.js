(() => {
  "use strict";

  const VERSION = "20260802-26-pagination";
  const originalFetch = window.__nativeFetch || window.fetch.bind(window);
  let pendingUiPage = null;
  let pendingUntil = 0;
  const requestHistory = [];

  function log(message, details) {
    console.log(`[SHORT PAGINATION ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output") || document.querySelector("#aad-log");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
    output.textContent = `[${time}] [短视频分页] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function isShortCatalog(url) {
    return /\/videos\/short\/?$/i.test(url.pathname);
  }

  function selectedCategory() {
    const value = document.querySelector("#category-select")?.value;
    return value === undefined || value === null || value === "" ? "0" : String(value);
  }

  function requestedScannerPageSize() {
    const value = Number(document.querySelector("#aad-home-page-size")?.value || 10);
    return [10, 20, 50, 100].includes(value) ? value : 10;
  }

  function normalizeRequest(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    let url;
    try { url = new URL(raw, location.href); }
    catch { return { input, init, meta: null }; }
    if (!isShortCatalog(url)) return { input, init, meta: null };

    let page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const now = Date.now();
    if (pendingUiPage !== null && now <= pendingUntil) {
      page = pendingUiPage;
      pendingUiPage = null;
      pendingUntil = 0;
    }

    const fromHomepageScanner = Boolean(document.querySelector("#aad-home-start:disabled"));
    const pageSize = fromHomepageScanner ? requestedScannerPageSize() : 10;
    const category = url.searchParams.get("categorieId") || selectedCategory();

    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("categorieId", category || "0");
    url.searchParams.set("pid", url.searchParams.get("pid") || "PH");

    const nextInit = {
      ...(init || {}),
      cache: "no-store",
      headers: new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    };
    nextInit.headers.set("cache-control", "no-cache");
    nextInit.headers.set("pragma", "no-cache");

    const nextInput = input instanceof Request
      ? new Request(url.href, { ...input, ...nextInit })
      : url.href;
    return {
      input: nextInput,
      init: input instanceof Request ? undefined : nextInit,
      meta: { page, pageSize, categorieId: category || "0", url: url.href }
    };
  }

  async function paginationFetch(input, init) {
    const normalized = normalizeRequest(input, init);
    if (!normalized.meta) return originalFetch(input, init);
    const started = performance.now();
    log("请求短视频页", normalized.meta);
    try {
      const response = await originalFetch(normalized.input, normalized.init);
      const record = {
        ...normalized.meta,
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        at: new Date().toISOString()
      };
      requestHistory.push(record);
      if (requestHistory.length > 100) requestHistory.shift();
      log("短视频页返回", record);
      return response;
    } catch (error) {
      log("短视频页请求失败", { ...normalized.meta, error: error.message || String(error) });
      throw error;
    }
  }

  window.__nativeFetch = paginationFetch;
  window.fetch = paginationFetch;

  document.addEventListener("click", (event) => {
    const next = event.target.closest("#next-page");
    const previous = event.target.closest("#previous-page");
    const reload = event.target.closest("#reload-catalog");
    if (!next && !previous && !reload) return;
    const match = (document.querySelector("#page-label")?.textContent || "").match(/(\d+)/);
    const current = Math.max(1, Number(match?.[1] || 1));
    pendingUiPage = reload ? 1 : next ? current + 1 : Math.max(1, current - 1);
    pendingUntil = Date.now() + 5000;
    log("界面分页按钮已指定下一次请求页码", { current, requested: pendingUiPage });
  }, true);

  document.addEventListener("change", (event) => {
    if (!event.target.matches("#category-select")) return;
    pendingUiPage = 1;
    pendingUntil = Date.now() + 5000;
  }, true);

  function installScannerPageSize() {
    const card = document.querySelector("#aad-home-scan-card");
    if (!card || document.querySelector("#aad-home-page-size")) return;
    const concurrency = document.querySelector("#aad-home-concurrency")?.closest("label");
    const label = document.createElement("label");
    label.innerHTML = '每页数量 <select id="aad-home-page-size"><option value="10" selected>10（APK 原版）</option><option value="20">20</option><option value="50">50</option><option value="100">100（实验）</option></select>';
    concurrency?.insertAdjacentElement("beforebegin", label);
  }

  const observer = new MutationObserver(installScannerPageSize);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  installScannerPageSize();

  window.SHORT_PAGINATION_DEBUG = {
    version: VERSION,
    history: requestHistory,
    forceNextPage(page) {
      pendingUiPage = Math.max(1, Number(page) || 1);
      pendingUntil = Date.now() + 10000;
    }
  };
  log("短视频分页修复已启用", { apkPageSize: 10 });
})();
