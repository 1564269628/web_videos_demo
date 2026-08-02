(() => {
  "use strict";

  const sourceUrl = "./app.js?v=20260802-4";
  const needle = `if (elements.playerEmpty) elements.playerEmpty.hidden = true;\nrenderVideos();\nsetBadge("正在加载视频…", "busy");`;
  const replacement = `if (elements.playerEmpty) elements.playerEmpty.hidden = true;\nif (elements.videoList) {\n[...elements.videoList.querySelectorAll(".video-card")].forEach((card, index) => {\ncard.classList.toggle("active", state.videos[index]?.id === video.id);\n});\n}\nsetBadge("正在加载视频…", "busy");`;

  fetch(sourceUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`app.js HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      const first = source.indexOf(needle);
      const last = source.lastIndexOf(needle);
      if (first < 0 || first !== last) throw new Error("无法唯一定位视频列表重建代码");

      const patched = source.replace(needle, replacement);
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
