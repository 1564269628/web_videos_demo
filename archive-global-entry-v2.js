(() => {
  "use strict";

  const VERSION = "20260802-23-preview";
  const CORE_URL = "./archive-global-downloader.js";
  const BUTTON_ID = "archive-global-entry-button";
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  let coreRecoveryPromise = null;
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

  function extractPayload(wrapperSource) {
    const match = wrapperSource.match(/const\s+payload\s*=\s*["']([A-Za-z0-9+/=]+)["']\s*;/);
    if (!match?.[1]) throw new Error("核心包装脚本中没有找到 gzip payload");
    return match[1];
  }

  function decodePayload(payload) {
    if (!window.pako?.ungzip) throw new Error("pako 尚未加载，无法恢复核心脚本");
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const source = window.pako.ungzip(bytes, { to: "string" });
    if (!source || source.length < 1000) throw new Error("pako 解压结果异常");
    return source;
  }

  function executeRecoveredSource(source) {
    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=archive-global-downloader.recovered.js`;
    document.head.append(script);
    script.remove();
  }

  function recoverCore() {
    if (globalModal() || coreOpenButton()) return Promise.resolve(true);
    if (coreRecoveryPromise) return coreRecoveryPromise;

    coreRecoveryPromise = (async () => {
      log("原核心自解压失败，正在改用 pako 恢复");
      const response = await nativeFetch(`${CORE_URL}?recovery=${Date.now()}`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`读取核心包装脚本失败：HTTP ${response.status}`);
      const wrapperSource = await response.text();
      const payload = extractPayload(wrapperSource);
      log("已读取核心 gzip 数据", {
        wrapperBytes: wrapperSource.length,
        payloadChars: payload.length,
        pako: Boolean(window.pako?.ungzip)
      });
      const source = decodePayload(payload);
      log("pako 解压成功，正在执行核心代码", { sourceBytes: source.length });
      executeRecoveredSource(source);
      const ready = await waitFor(() => globalModal() || coreOpenButton(), 10000, 80);
      if (!ready) throw new Error("核心代码已执行，但没有创建全部作者下载界面");
      log("全部作者下载器核心恢复成功");
      return true;
    })().catch((error) => {
      log("pako 恢复核心脚本失败", {
        name: error?.name,
        message: error?.message || String(error),
        pako: Boolean(window.pako?.ungzip)
      }, "error");
      throw error;
    }).finally(() => {
      coreRecoveryPromise = null;
    });

    return coreRecoveryPromise;
  }

  async function openGlobalDownloader({ auto = false } = {}) {
    if (opening) return;
    opening = true;
    try {
      await prepareArchiveCenter();
      installButton();

      if (revealModal()) return;

      await recoverCore();
      if (!revealModal()) {
        throw new Error("核心脚本恢复完成，但没有找到全部作者下载界面");
      }
    } catch (error) {
      log("打开全部作者下载中心失败", {
        error: error.message || String(error),
        coreLoaded: Boolean(document.querySelector('script[src*="archive-global-downloader.js"]')),
        modalExists: Boolean(globalModal()),
        archiveCenter: Boolean(window.ARCHIVE_CENTER),
        pako: Boolean(window.pako?.ungzip)
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

      window.ARCHIVE_GLOBAL_ENTRY = {
        version: VERSION,
        open: openGlobalDownloader,
        recover: recoverCore,
        get status() {
          return {
            modalExists: Boolean(globalModal()),
            buttonExists: Boolean(document.getElementById(BUTTON_ID)),
            coreButtonExists: Boolean(coreOpenButton()),
            recovering: Boolean(coreRecoveryPromise),
            pako: Boolean(window.pako?.ungzip),
            opening
          };
        }
      };

      if (!autoOpened) {
        autoOpened = true;
        setTimeout(() => openGlobalDownloader({ auto: true }), 250);
      }
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
