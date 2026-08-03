(() => {
  "use strict";

  const LOADER_VERSION = "20260803-36-scanner-loader";
  const PINNED_URLS = [
    "https://cdn.jsdelivr.net/gh/1564269628/web_videos_demo@a2979e3a54c4100e2180cf1b44a86c7b00d307ce/archive-homepage-scanner.js",
    "https://raw.githubusercontent.com/1564269628/web_videos_demo/a2979e3a54c4100e2180cf1b44a86c7b00d307ce/archive-homepage-scanner.js"
  ];

  function log(message, details, level = "log") {
    console[level](`[HOMEPAGE SCANNER LOADER ${LOADER_VERSION}] ${message}`, details ?? "");
  }

  async function fetchSource() {
    const errors = [];
    for (const url of PINNED_URLS) {
      try {
        const response = await fetch(url, { cache: "force-cache", mode: "cors", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.includes("20260802-25-homepage-scan") || !text.includes("function installTaskWatcher")) {
          throw new Error("返回内容不是预期的首页作者扫描器");
        }
        return { text, url };
      } catch (error) {
        errors.push(`${url}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | "));
  }

  function patchSource(source) {
    let code = source;
    code = code.replace(
      'const VERSION = "20260802-25-homepage-scan";',
      'const VERSION = "20260803-36-homepage-scan-direct-cover";'
    );

    const marker = "  function installTaskWatcher() {\n    const tasks =";
    if (!code.includes(marker)) throw new Error("无法定位旧的下载任务封面观察器");
    code = code.replace(
      marker,
      "  function installTaskWatcher() {\n    // 新下载核心会在单个视频写完后直接保存封面，不再扫描作者目录匹配任务。\n    if (window.ARCHIVE_RUNTIME_OPTIMIZER?.directCoverSave) return;\n    const tasks ="
    );

    code = code.replace(
      'log("首页作者扫描功能已加载；作品封面仅在下载分片阶段保存");',
      'log("首页作者扫描功能已加载；新视频封面由下载核心在完成后直接保存，不再监听下载进度扫描目录");'
    );

    code += `\n//# sourceURL=archive-homepage-scanner-direct-cover.js?v=${LOADER_VERSION}\n`;
    return code;
  }

  async function boot() {
    const fetched = await fetchSource();
    const code = patchSource(fetched.text);
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = blobUrl;
        script.onload = resolve;
        script.onerror = () => reject(new Error("浏览器拒绝执行首页作者扫描器"));
        document.head.append(script);
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    log("首页作者扫描器已加载，下载期间目录匹配扫描已关闭", { source: fetched.url });
  }

  boot().catch((error) => log("首页作者扫描器加载失败", error.message || String(error), "error"));
})();