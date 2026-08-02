(() => {
  "use strict";

  const VERSION = "20260802-22-preview";
  const CORE_URL = `./archive-global-downloader.js?v=${VERSION}`;
  const BUTTON_ID = "archive-global-entry-button";
  let coreReloadPromise = null;
  let opening = false;
  let autoOpened = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(message, details, level = "log") {
    console[level](`[GLOBAL ENTRY ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${safeJson(details)}`;
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `[${time}] [全部作者入口] ${message}${suffix}\n${old}`.slice(0, 140000);
  }

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  async function waitFor(getter, timeout = 12000, interval = 50) {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = getter();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function prepareArchiveCenter() {
    const center = await waitFor(() => window.ARCHIVE_CENTER, 15000);
    if (!center) throw new Error("ARCHIVE_CENTER 没有初始化");

    center.open();
    await waitFor(() => document.querySelector(".archive-center-header-actions"), 8000);

    // V2 预览默认进入归档总目录模式，不自动恢复上次的单作者目录。
    try {
      await center.forgetFolder?.();
      log("已关闭上次单作者目录的自动恢复");
    } catch (error) {
      log("清除上次单作者目录失败", error.message || String(error), "warn");
    }

    const name = document.querySelector("#archive-author-name");
    const status = document.querySelector("#archive-folder-status");
    if (name) name.textContent = "全部作者归档下载中心";
    if (status) status.textContent = "请选择归档总目录，例如 F:\\tools\\short_videos";
    return center;
  }

  function globalModal() {
    return document.querySelector("#archive-global-downloader");
  }

  function coreOpenButton() {
    return [...document.querySelectorAll("button")].find((button) => {
      if (button.id === BUTTON_ID) return false;
      const text = (button.textContent || "").replace(/\s+/g, "").trim();
      return text.includes("下载全部作者") || text.includes("全部作者下载");
    }) || null;
  }

  function revealModal() {
    const modal = globalModal();
    if (modal) {
      modal.hidden = false;
      document.body.classList.add("agd-open");
      document.querySelector("#archive-close")?.click();
      log("已打开全部作者下载中心");
      return true;
    }

    const button = coreOpenButton();
    if (button) {
      button.click();
      return true;
    }
    return false;
  }

  function reloadCore() {
    if (coreReloadPromise) return coreReloadPromise;
    coreReloadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${CORE_URL}&reload=${Date.now()}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("archive-global-downloader.js 加载失败"));
      document.head.append(script);
    }).finally(() => {
      setTimeout(() => { coreReloadPromise = null; }, 2000);
    });
    return coreReloadPromise;
  }

  async function openGlobalDownloader({ auto = false } = {}) {
    if (opening) return;
    opening = true;
    try {
      await prepareArchiveCenter();
      installButton();

      if (revealModal()) return;

      log("全局下载器尚未创建，重新加载核心脚本");
      await reloadCore();
      const ready = await waitFor(() => globalModal() || coreOpenButton(), 10000, 80);
      if (!ready || !revealModal()) {
        throw new Error("核心脚本已加载，但没有创建全部作者下载界面");
      }
    } catch (error) {
      log("打开全部作者下载中心失败", {
        error: error.message || String(error),
        coreLoaded: Boolean(document.querySelector('script[src*="archive-global-downloader.js"]')),
        modalExists: Boolean(globalModal()),
        archiveCenter: Boolean(window.ARCHIVE_CENTER)
      }, "error");
      if (!auto) {
        alert(`全部作者下载中心启动失败：${error.message || error}\n\n请在页面底部日志查看“全部作者入口”信息。`);
      }
    } finally {
      opening = false;
    }
  }

  function installButton() {
    const actions = document.querySelector(".archive-center-header-actions");
    if (!actions || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = BUTTON_ID;
    button.textContent = "下载全部作者";
    button.title = "扫描归档总目录并统一下载所有作者的全部视频";
    button.addEventListener("click", () => openGlobalDownloader());
    actions.prepend(button);
    log("已安装固定的“下载全部作者”按钮");
  }

  async function boot() {
    try {
      await prepareArchiveCenter();
      installButton();

      const observer = new MutationObserver(() => installButton());
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // 预览版默认直接展示全部作者下载中心；单作者中心仍可通过“选择作者文件夹”使用。
      if (!autoOpened) {
        autoOpened = true;
        setTimeout(() => openGlobalDownloader({ auto: true }), 250);
      }

      window.ARCHIVE_GLOBAL_ENTRY = {
        version: VERSION,
        open: openGlobalDownloader,
        get status() {
          return {
            modalExists: Boolean(globalModal()),
            buttonExists: Boolean(document.getElementById(BUTTON_ID)),
            coreButtonExists: Boolean(coreOpenButton()),
            opening
          };
        }
      };
    } catch (error) {
      log("全部作者入口初始化失败", error.message || String(error), "error");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
