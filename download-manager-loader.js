(() => {
  "use strict";

  const sourceUrl = "./download-manager-v2.js?v=20260802-9";

  const oldBlock = `    const looksJson = type.includes("application/json") || prefix.startsWith("{") || prefix.startsWith("[");
    if (looksJson) {
      let parsed = null;
      try { parsed = JSON.parse(bytesToText(bytes, 8192)); } catch { }
      const summary = parsed ? summarizeJson(parsed) : bytesToText(bytes, 500);
      const text = \`${summary} ${bytesToText(bytes, 500)}\`.toLowerCase();
      const rateLimited = /too many|rate|limit|频繁|过快|429|请求过多/.test(text);
      return { kind: "json", message: \`JSON：${summary}\`, refreshable: true, rateLimited, json: parsed };
    }`;

  const newBlock = `    // 加密媒体分片是随机二进制，首字节可能恰好是“{”或“[”。
    // 只有 JSON 真正解析成功，或服务器明确声明 JSON 且响应较小时，
    // 才把它当作业务错误；否则按有效媒体字节继续处理。
    const jsonMime = /\\/(?:[^;+\\s]+\\+)?json(?:\\s*;|$)/i.test(type);
    const beginsLikeJson = prefix.startsWith("{") || prefix.startsWith("[");
    if (jsonMime || beginsLikeJson) {
      const jsonText = bytesToText(bytes, Math.min(bytes.length, 262144));
      let parsed = null;
      try { parsed = JSON.parse(jsonText); } catch { }

      if (parsed !== null) {
        const summary = summarizeJson(parsed);
        const text = \`${summary} ${jsonText.slice(0, 500)}\`.toLowerCase();
        const rateLimited = /too many|rate|limit|频繁|过快|429|请求过多/.test(text);
        return { kind: "json", message: \`JSON：${summary}\`, refreshable: true, rateLimited, json: parsed };
      }

      if (jsonMime && bytes.length <= 262144) {
        const summary = jsonText.slice(0, 500) || "无法解析的 JSON 响应";
        const rateLimited = /too many|rate|limit|频繁|过快|429|请求过多/.test(summary.toLowerCase());
        return { kind: "json", message: \`JSON：${summary}\`, refreshable: true, rateLimited, json: null };
      }
    }`;

  fetch(sourceUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`download-manager-v2.js HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      const first = source.indexOf(oldBlock);
      const last = source.lastIndexOf(oldBlock);
      if (first < 0 || first !== last) {
        throw new Error("无法唯一定位媒体响应判定代码");
      }

      const patched = source.replace(oldBlock, newBlock);
      const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
      const script = document.createElement("script");
      script.src = blobUrl;
      script.onload = () => URL.revokeObjectURL(blobUrl);
      script.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        throw new Error("修正后的下载器执行失败");
      };
      document.body.append(script);
    })
    .catch((error) => {
      console.error("download-manager-loader", error);
      const manager = document.querySelector("#download-manager");
      if (manager) {
        const status = manager.querySelector(".download-manager-status");
        if (status) status.textContent = `下载器加载失败：${error.message}`;
      }
    });
})();
