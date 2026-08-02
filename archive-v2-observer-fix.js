(() => {
  "use strict";

  const NativeMutationObserver = window.__ARCHIVE_V2_NATIVE_MUTATION_OBSERVER || window.MutationObserver;
  let timer = 0;
  let lastFolder = "";

  function schedule(reason, delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const api = window.ARCHIVE_V2;
      if (!api?.applyDedupe) return;
      try {
        await api.applyDedupe();
        console.info(`[ARCHIVE V2 FIX] 去重检查完成：${reason}`);
      } catch (error) {
        console.warn(`[ARCHIVE V2 FIX] 去重检查失败：${reason}`, error);
      }
    }, delay);
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.(
      "#archive-choose-folder, #archive-refresh-folder, #archive-prev, #archive-next, #archive-v2-root, #archive-v2-rescan, #archive-filter"
    );
    if (trigger) schedule(`click:${trigger.id}`, trigger.id.includes("folder") ? 900 : 300);
  }, true);

  document.addEventListener("input", (event) => {
    if (event.target.matches?.("#archive-search")) schedule("search", 500);
  }, true);

  const observer = new NativeMutationObserver((mutations) => {
    let cardsAdded = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(".archive-work-card") || node.querySelector?.(".archive-work-card")) {
          cardsAdded = true;
          break;
        }
      }
      if (cardsAdded) break;
    }
    if (cardsAdded) schedule("library-render", 250);

    const folder = document.querySelector("#archive-folder-status")?.textContent?.trim() || "";
    if (folder && folder !== lastFolder && !/尚未选择|请选择|正在扫描/.test(folder)) {
      lastFolder = folder;
      schedule("author-folder-changed", 900);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  console.info("[ARCHIVE V2 FIX] 安全的去重触发器已启用");
})();
