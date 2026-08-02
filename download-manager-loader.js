(() => {
  "use strict";

  const sourceUrl = "./download-manager-v2.js?v=20260802-10";
  const fetcher = window.__nativeFetch || window.fetch.bind(window);
  const oldLine = '    const looksJson = type.includes("application/json") || prefix.startsWith("{") || prefix.startsWith("[");';
  const newLines = [
    '    // 媒体分片是随机二进制，首字节可能碰巧是“{”或“[”。',
    '    // 只有响应较小且确实能被 JSON.parse 解析，才判定为 JSON 业务错误。',
    '    const jsonMime = /\\/(?:[^;+\\s]+\\+)?json(?:\\s*;|$)/i.test(type);',
    '    const beginsLikeJson = prefix.startsWith("{") || prefix.startsWith("[");',
    '    let parsedJsonProbe = null;',
    '    if ((jsonMime || beginsLikeJson) && bytes.length <= 262144) {',
    '      try { parsedJsonProbe = JSON.parse(bytesToText(bytes, 262144)); } catch { parsedJsonProbe = null; }',
    '    }',
    '    const looksJson = parsedJsonProbe !== null || (jsonMime && bytes.length <= 262144);'
  ].join("\n");

  function execute(source) {
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const script = document.createElement("script");
    script.src = blobUrl;
    script.onload = () => URL.revokeObjectURL(blobUrl);
    script.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      console.error("修正后的下载器执行失败");
    };
    document.body.append(script);
  }

  fetcher(sourceUrl, { cache: "no-store", credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`download-manager-v2.js HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      const occurrences = source.split(oldLine).length - 1;
      if (occurrences !== 1) throw new Error(`无法唯一定位 JSON 判定代码：${occurrences}`);
      execute(source.replace(oldLine, newLines));
    })
    .catch((error) => {
      console.error("download-manager-loader", error);
      const fallback = document.createElement("script");
      fallback.src = sourceUrl;
      document.body.append(fallback);
    });
})();
