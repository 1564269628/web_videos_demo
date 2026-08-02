(() => {
  "use strict";

  const sourceUrl = "./app.js?v=20260802-8";
  const renderNeedle = `if (elements.playerEmpty) elements.playerEmpty.hidden = true;\nrenderVideos();\nsetBadge("正在加载视频…", "busy");`;
  const renderReplacement = `if (elements.playerEmpty) elements.playerEmpty.hidden = true;\nif (elements.videoList) {\n[...elements.videoList.querySelectorAll(".video-card")].forEach((card, index) => {\ncard.classList.toggle("active", state.videos[index]?.id === video.id);\n});\n}\nsetBadge("正在加载视频…", "busy");`;

  const rewriteMarker = "function rewritePlaylist(playlist, sourceUrl) {";
  const rewriteHelper = `function normalizeMediaUrl(value) {\nconst input = String(value || "");\nif (!/^https?:\\/\\//i.test(input)) return input;\ntry {\nconst url = new URL(input);\nurl.pathname = \`/\${url.pathname.replace(/^\\/+/, "").replace(/\\/{2,}/g, "/")}\`;\nreturn url.href;\n} catch {\nreturn input.replace(/^(https?:\\/\\/[^/]+)\\/{2,}/i, "$1/");\n}\n}\n`;
  const quotedUriNeedle = 'try { return `URI="${new URL(uri, sourceUrl).href}"`; }';
  const quotedUriReplacement = 'try { return `URI="${normalizeMediaUrl(new URL(uri, sourceUrl).href)}"`; }';
  const mediaLineNeedle = "try { return new URL(trimmed, sourceUrl).href; }";
  const mediaLineReplacement = "try { return normalizeMediaUrl(new URL(trimmed, sourceUrl).href); }";

  fetch(sourceUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`app.js HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      const first = source.indexOf(renderNeedle);
      const last = source.lastIndexOf(renderNeedle);
      if (first < 0 || first !== last) throw new Error("无法唯一定位视频列表重建代码");

      let patched = source.replace(renderNeedle, renderReplacement);

      const rewriteFirst = patched.indexOf(rewriteMarker);
      const rewriteLast = patched.lastIndexOf(rewriteMarker);
      if (rewriteFirst < 0 || rewriteFirst !== rewriteLast) {
        throw new Error("无法唯一定位播放列表重写函数");
      }
      patched = patched.replace(rewriteMarker, `${rewriteHelper}${rewriteMarker}`);

      const quotedFirst = patched.indexOf(quotedUriNeedle);
      const quotedLast = patched.lastIndexOf(quotedUriNeedle);
      if (quotedFirst < 0 || quotedFirst !== quotedLast) {
        throw new Error("无法唯一定位 M3U8 URI 属性处理代码");
      }
      patched = patched.replace(quotedUriNeedle, quotedUriReplacement);

      const mediaFirst = patched.indexOf(mediaLineNeedle);
      const mediaLast = patched.lastIndexOf(mediaLineNeedle);
      if (mediaFirst < 0 || mediaFirst !== mediaLast) {
        throw new Error("无法唯一定位 M3U8 分片地址处理代码");
      }
      patched = patched.replace(mediaLineNeedle, mediaLineReplacement);

      const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
      const script = document.createElement("script");
      script.src = blobUrl;
      script.onload = () => URL.revokeObjectURL(blobUrl);
      script.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        throw new Error("修正后的 app.js 执行失败");
      };
      document.body.append(script);
    })
    .catch((error) => {
      console.error("app-loader", error);
      const badge = document.querySelector("#connection-badge");
      if (badge) {
        badge.textContent = `页面脚本加载失败：${error.message}`;
        badge.className = "badge badge-error";
      }
    });
})();
