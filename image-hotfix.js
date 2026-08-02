(() => {
  "use strict";

  const rawFetch = window.__nativeFetch || window.fetch.bind(window);
  const exactAssetFetches = new Map();
  const logicalAssetCache = new Map();
  const rememberedImageSources = new Map();

  function requestUrl(input) {
    try {
      return new URL(typeof input === "string" ? input : input.url, location.href);
    } catch {
      return null;
    }
  }

  function isImageAsset(url) {
    if (!url) return false;
    return /\.(?:ceb|geb)(?:@[^/?#]+)?(?:$|[?#])/i.test(url.href) || /@(?:webp|png)-\d+(?:$|[?#])/i.test(url.href);
  }

  function logicalAssetKey(url) {
    return `${url.pathname}${url.search}`;
  }

  async function snapshotResponse(response) {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: await response.arrayBuffer()
    };
  }

  function restoreResponse(snapshot) {
    return new Response(snapshot.body.slice(0), {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers: snapshot.headers
    });
  }

  // enhancement.js 会把该函数保存为 binaryFetch。这里按 URL 去重，并按资源路径
  // 复用已经成功返回的大文件，避免同一张封面在多个 CDN 上被反复请求。
  window.__nativeFetch = async (input, init = {}) => {
    const url = requestUrl(input);
    if (!isImageAsset(url) || String(init.method || "GET").toUpperCase() !== "GET") {
      return rawFetch(input, init);
    }

    const logicalKey = logicalAssetKey(url);
    const logicalHit = logicalAssetCache.get(logicalKey);
    if (logicalHit) return restoreResponse(await logicalHit);

    const exactKey = url.href;
    let request = exactAssetFetches.get(exactKey);
    if (!request) {
      request = rawFetch(input, init).then(snapshotResponse);
      exactAssetFetches.set(exactKey, request);
    }

    const snapshot = await request;
    // 正常封面通常为几十 KB；百来字节的响应多为节点错误信息，不能作为跨域复用结果。
    if (snapshot.status >= 200 && snapshot.status < 300 && snapshot.body.byteLength > 1024) {
      logicalAssetCache.set(logicalKey, Promise.resolve(snapshot));
    }
    return restoreResponse(snapshot);
  };

  function isPlaceholder(src) {
    return /^data:image\/svg\+xml/i.test(String(src || ""));
  }

  function rememberOrRestore(img) {
    if (!(img instanceof HTMLImageElement)) return;
    const key = img.dataset.imageRequest || "";
    if (!key) return;
    const src = img.currentSrc || img.src || "";

    if (img.dataset.imageState === "loaded" && src && !isPlaceholder(src)) {
      rememberedImageSources.set(key, src);
      return;
    }

    const remembered = rememberedImageSources.get(key);
    if (remembered && isPlaceholder(src) && img.src !== remembered) {
      img.onerror = null;
      img.src = remembered;
      img.dataset.imageState = "loaded";
    }
  }

  function scanImages(root) {
    if (root instanceof HTMLImageElement) rememberOrRestore(root);
    root?.querySelectorAll?.("img").forEach(rememberOrRestore);
  }

  const imageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        rememberOrRestore(mutation.target);
        continue;
      }
      mutation.removedNodes.forEach(scanImages);
      mutation.addedNodes.forEach(scanImages);
    }
  });

  imageObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "data-image-request", "data-image-state"]
  });

  function imageSnapshot(img) {
    if (!img) return null;
    const src = img.currentSrc || img.src || "";
    if (!src || isPlaceholder(src)) return null;
    return {
      src,
      request: img.dataset.imageRequest || "",
      state: img.dataset.imageState || "loaded"
    };
  }

  function restoreImage(img, snapshot) {
    if (!img || !snapshot) return;
    img.onerror = null;
    img.src = snapshot.src;
    if (snapshot.request) img.dataset.imageRequest = snapshot.request;
    img.dataset.imageState = snapshot.state;
  }

  // app.js 旧逻辑在点击播放时会重建整个列表。把旧卡片中已经解出的 blob
  // 立即迁移到同标题的新卡片，MutationObserver 回调发生在浏览器绘制前，因此不会闪空。
  const list = document.querySelector("#video-list");
  if (list) {
    let removedCards = [];
    const listObserver = new MutationObserver((mutations) => {
      const removed = [];
      let addedCard = false;

      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(".video-card")) removed.push(node);
          node.querySelectorAll?.(".video-card").forEach((card) => removed.push(card));
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(".video-card") || node.querySelector?.(".video-card")) addedCard = true;
        }
      }

      if (removed.length) {
        removedCards = removed.map((card) => ({
          title: card.querySelector(".video-meta strong")?.textContent?.trim() || "",
          cover: imageSnapshot(card.querySelector(".video-cover img"))
        }));
      }

      if (!addedCard || !removedCards.length) return;
      const cards = [...list.querySelectorAll(":scope > .video-card")];
      cards.forEach((card, index) => {
        const old = removedCards[index];
        const title = card.querySelector(".video-meta strong")?.textContent?.trim() || "";
        if (!old || !old.title || old.title !== title) return;
        restoreImage(card.querySelector(".video-cover img"), old.cover);
      });
      removedCards = [];
    });
    listObserver.observe(list, { childList: true });
  }
})();
