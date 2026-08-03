(() => {
  "use strict";

  const LOADER_VERSION = "20260803-37-signed-url-retry";
  const PINNED_CORE_URLS = [
    "https://cdn.jsdelivr.net/gh/1564269628/web_videos_demo@a2979e3a54c4100e2180cf1b44a86c7b00d307ce/archive-all-authors.js",
    "https://raw.githubusercontent.com/1564269628/web_videos_demo/a2979e3a54c4100e2180cf1b44a86c7b00d307ce/archive-all-authors.js"
  ];

  function log(message, details, level = "log") {
    console[level](`[ALL AUTHORS LOADER ${LOADER_VERSION}] ${message}`, details ?? "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    output.textContent = `[${time}] [下载核心] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function replaceRequired(source, search, replacement, label) {
    if (!source.includes(search)) throw new Error(`下载核心补丁定位失败：${label}`);
    return source.replace(search, replacement);
  }

  async function fetchCore() {
    const errors = [];
    for (const url of PINNED_CORE_URLS) {
      try {
        const response = await fetch(url, { cache: "force-cache", mode: "cors", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.includes("20260802-24-all-authors") || !text.includes("async function downloadPrepared")) {
          throw new Error("返回内容不是预期的归档核心");
        }
        return { text, url };
      } catch (error) {
        errors.push(`${url}: ${error.message || error}`);
      }
    }
    throw new Error(errors.join(" | "));
  }

  function patchCore(source) {
    let code = source;

    code = replaceRequired(
      code,
      'const VERSION = "20260802-24-all-authors";',
      'const VERSION = "20260803-37-all-authors-turbo-retry";',
      "版本号"
    );

    code = replaceRequired(
      code,
      "  const PAGE_SIZE = 60;",
      "  const PAGE_SIZE = 60;\n  const __turboCores = Math.max(4, Number(navigator.hardwareConcurrency || 8));\n  const __turboMemory = Math.max(4, Number(navigator.deviceMemory || 8));\n  const __turboVideoDefault = Math.max(16, __turboCores * 2, Math.floor(__turboMemory * 2));\n  const __turboSegmentDefault = Math.max(32, __turboCores * 4, Math.floor(__turboMemory * 4));",
      "自动并发参数"
    );

    code = replaceRequired(code, "    maxSegments: 50,", "    maxSegments: 1000000,", "默认分片上限");
    code = replaceRequired(code, "    videoConcurrency: 4,", "    videoConcurrency: __turboVideoDefault,", "默认视频并发");
    code = replaceRequired(code, "    segmentConcurrency: 8,", "    segmentConcurrency: __turboSegmentDefault,", "默认分片并发");
    code = replaceRequired(code, "    smallOnly: true", "    smallOnly: false", "默认取消分片数量限制");

    code = replaceRequired(
      code,
      "    rootWrite: Promise.resolve()\n  };\n\n  const $ =",
      "    rootWrite: Promise.resolve()\n  };\n\n  // 旧设置低于自动值时直接提升；不再保留 8/16 的硬上限。\n  state.settings.videoConcurrency = Math.max(__turboVideoDefault, Math.floor(Number(state.settings.videoConcurrency) || 0));\n  state.settings.segmentConcurrency = Math.max(__turboSegmentDefault, Math.floor(Number(state.settings.segmentConcurrency) || 0));\n  state.settings.maxSegments = Math.max(1000000, Math.floor(Number(state.settings.maxSegments) || 0));\n  state.settings.smallOnly = false;\n  try { localStorage.setItem(\"hq-all-authors-settings\", JSON.stringify(state.settings)); } catch {}\n\n  const $ =",
      "提升已保存的旧并发设置"
    );

    code = replaceRequired(
      code,
      "      const concurrency = clamp(state.settings.segmentConcurrency, 1, 16);",
      "      const concurrency = Math.max(1, Math.floor(Number(state.settings.segmentConcurrency) || __turboSegmentDefault));",
      "移除单视频分片并发 16 上限"
    );

    code = replaceRequired(
      code,
      "    const workers = Array.from({ length: clamp(state.settings.videoConcurrency, 1, 8) }, (_, index) => workerLoop(index + 1));",
      "    const requestedWorkers = Math.max(1, Math.floor(Number(state.settings.videoConcurrency) || __turboVideoDefault));\n    const workerCount = Math.max(1, Math.min(state.queue.length || 1, requestedWorkers));\n    const workers = Array.from({ length: workerCount }, (_, index) => workerLoop(index + 1));\n    log(\"下载队列以高并发模式启动\", { requestedWorkers, workerCount, segmentConcurrency: state.settings.segmentConcurrency, queued: state.queue.length });",
      "移除同时视频 8 上限"
    );

    code = replaceRequired(
      code,
      '<label>同时下载视频 <input id="aad-video-concurrency" type="number" min="1" max="8"></label>',
      '<label>同时下载视频（无硬上限） <input id="aad-video-concurrency" type="number" min="1" step="1"></label>',
      "视频并发输入框"
    );

    code = replaceRequired(
      code,
      '<label>单视频分片并发 <input id="aad-segment-concurrency" type="number" min="1" max="16"></label>',
      '<label>单视频分片并发（无硬上限） <input id="aad-segment-concurrency" type="number" min="1" step="1"></label>',
      "分片并发输入框"
    );

    code = replaceRequired(
      code,
      '["#aad-video-concurrency", "videoConcurrency", 1, 8],',
      '["#aad-video-concurrency", "videoConcurrency", 1, Number.MAX_SAFE_INTEGER],',
      "视频并发设置上限"
    );

    code = replaceRequired(
      code,
      '["#aad-segment-concurrency", "segmentConcurrency", 1, 16]',
      '["#aad-segment-concurrency", "segmentConcurrency", 1, Number.MAX_SAFE_INTEGER]',
      "分片并发设置上限"
    );

    code = replaceRequired(
      code,
      '    await writeJson(directory, "download.json", download);\n    item.videoHandle = fileHandle;',
      '    await writeJson(directory, "download.json", download);\n    try {\n      await window.ARCHIVE_RUNTIME_OPTIMIZER?.saveCoverForDirectory?.(directory, item);\n    } catch (coverError) {\n      log("视频已完成，但保存封面失败", { id: item.id, title: item.title, error: coverError?.message || String(coverError) }, "warn");\n    }\n    item.videoHandle = fileHandle;',
      "下载完成后直接保存封面"
    );

    code = replaceRequired(
      code,
      "      const result = await downloadPrepared(item, prepared, task);",
      "      let result;\n      try {\n        result = await downloadPrepared(item, prepared, task);\n      } catch (firstError) {\n        const firstMessage = firstError?.message || String(firstError);\n        const retryable = /MEDIA_SEGMENT_UNAVAILABLE|视频分片不可用|HTML(?:\\/JSON)?(?: 404| 错误页)|HTTP 40[134]|signature|expired|签名过期/i.test(firstMessage);\n        if (!retryable || state.controller?.signal.aborted || state.paused) throw firstError;\n\n        task.phase = \"刷新过期播放地址\";\n        task.doneSegments = 0;\n        task.bytes = 0;\n        task.speed = 0;\n        task.speedAt = performance.now();\n        task.speedBytes = 0;\n        task.preferredOrigin = \"\";\n        task.disabledOrigins = new Set();\n        renderTasks();\n        log(\"分片地址失效，正在获取新的签名并重试整条视频\", {\n          author: item.author.folderName,\n          id: item.id,\n          title: item.title,\n          oldPlaylistUrl: prepared.url,\n          error: firstMessage\n        }, \"warn\");\n\n        try {\n          prepared = await preparePlaylist(item, true);\n          item.segmentCount = prepared.parsed.segments.length;\n          item.playlistUrl = prepared.url;\n          task.totalSegments = item.segmentCount;\n          task.phase = \"使用新签名重新下载\";\n          renderTasks();\n          result = await downloadPrepared(item, prepared, task);\n          log(\"刷新签名后重试成功\", {\n            author: item.author.folderName,\n            id: item.id,\n            title: item.title,\n            newPlaylistUrl: prepared.url,\n            segments: result.segmentCount\n          });\n        } catch (retryError) {\n          throw new Error(`旧分片地址失效；刷新视频播放地址后仍下载失败：${retryError?.message || retryError}`);\n        }\n      }",
      "分片签名失效后刷新播放地址重试"
    );

    code += `\n//# sourceURL=archive-all-authors-turbo-core.js?v=${LOADER_VERSION}\n`;
    return code;
  }

  async function boot() {
    if (window.__ALL_AUTHORS_TURBO_LOADING__) return window.__ALL_AUTHORS_TURBO_LOADING__;
    window.__ALL_AUTHORS_TURBO_LOADING__ = (async () => {
      const fetched = await fetchCore();
      const patched = patchCore(fetched.text);
      const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = blobUrl;
          script.onload = resolve;
          script.onerror = () => reject(new Error("浏览器拒绝执行高并发归档核心"));
          document.head.append(script);
        });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      log("高并发归档核心已加载", {
        source: fetched.url,
        videoConcurrencyHardLimit: null,
        segmentConcurrencyHardLimit: null,
        automaticDirectoryRescan: false,
        directCoverSave: true,
        expiredSignedUrlRetry: true
      });
    })();
    return window.__ALL_AUTHORS_TURBO_LOADING__;
  }

  boot().catch((error) => {
    log("高并发归档核心加载失败", error.message || String(error), "error");
    const message = document.querySelector("#log-output");
    if (message) message.textContent = `归档核心加载失败：${error.message || error}\n${message.textContent || ""}`;
  });
})();
