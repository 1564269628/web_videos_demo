(() => {
  "use strict";

  const VERSION = "20260802-23-preview";
  const CORE_PATH = "./archive-global-downloader.js";
  const nativeFetch = window.__nativeFetch || window.fetch.bind(window);
  let recoveryPromise = null;

  function log(message, details, level = "log") {
    console[level](`[GLOBAL RECOVERY ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let suffix = "";
    if (details !== undefined) {
      try { suffix = `\n${JSON.stringify(details, null, 2)}`; }
      catch { suffix = `\n${String(details)}`; }
    }
    const old = output.textContent === "页面启动中…" ? "" : (output.textContent || "");
    output.textContent = `[${time}] [全部作者恢复器] ${message}${suffix}\n${old}`.slice(0, 140000);
  }

  function ready() {
    return Boolean(
      document.querySelector("#archive-global-downloader") ||
      window.ARCHIVE_GLOBAL_DOWNLOADER
    );
  }

  function extractPayload(source) {
    const match = source.match(/const\s+payload\s*=\s*["']([A-Za-z0-9+/=]+)["']\s*;/);
    if (!match?.[1]) throw new Error("核心包装脚本中没有找到 gzip payload");
    return match[1];
  }

  function decodeWithPako(payload) {
    if (!window.pako?.ungzip) throw new Error("pako 尚未加载");
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const source = window.pako.ungzip(bytes, { to: "string" });
    if (!source || source.length < 1000) throw new Error("pako 解压结果异常");
    return source;
  }

  function execute(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.textContent = `${source}\n//# sourceURL=archive-global-downloader.recovered.js`;
      try {
        document.head.append(script);
        script.remove();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  async function waitReady(timeout = 10000) {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      if (ready()) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function recover({ force = false } = {}) {
    if (ready() && !force) return true;
    if (recoveryPromise) return recoveryPromise;

    recoveryPromise = (async () => {
      log("检测到核心自解压失败，改用 pako 恢复");
      const response = await nativeFetch(`${CORE_PATH}?recovery=${Date.now()}`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`读取核心包装脚本失败：HTTP ${response.status}`);
      const wrapperSource = await response.text();
      const payload = extractPayload(wrapperSource);
      log("已提取 gzip payload", { wrapperBytes: wrapperSource.length, payloadChars: payload.length });
      const source = decodeWithPako(payload);
      log("pako 解压成功，正在执行核心代码", { sourceBytes: source.length });
      await execute(source);
      const ok = await waitReady();
      if (!ok) throw new Error("核心代码已执行，但仍未创建全部作者界面");
      log("全部作者下载中心恢复成功");
      return true;
    })().catch((error) => {
      log("全部作者下载中心恢复失败", {
        name: error?.name,
        message: error?.message || String(error),
        pako: Boolean(window.pako?.ungzip)
      }, "error");
      throw error;
    }).finally(() => {
      recoveryPromise = null;
    });

    return recoveryPromise;
  }

  window.ARCHIVE_GLOBAL_RECOVERY = {
    version: VERSION,
    recover,
    get status() {
      return {
        ready: ready(),
        recovering: Boolean(recoveryPromise),
        pako: Boolean(window.pako?.ungzip)
      };
    }
  };

  setTimeout(() => {
    if (!ready()) recover().catch(() => {});
  }, 100);
})();
