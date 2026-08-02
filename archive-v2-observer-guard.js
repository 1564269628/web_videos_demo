(() => {
  "use strict";

  const NativeMutationObserver = window.MutationObserver;
  let archiveObserverSuppressed = false;

  window.__ARCHIVE_V2_NATIVE_MUTATION_OBSERVER = NativeMutationObserver;

  window.MutationObserver = class ArchiveV2SafeMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      const source = Function.prototype.toString.call(callback);
      const isArchiveV2Observer =
        !archiveObserverSuppressed &&
        source.includes("enhanceArchiveCenter") &&
        source.includes("decorateDuplicateCards") &&
        source.includes("applyDedupeToCurrent");

      if (isArchiveV2Observer) {
        archiveObserverSuppressed = true;
        super(() => {});
        console.info("[ARCHIVE V2 GUARD] 已替换可能自触发的归档 V2 DOM 观察器");
      } else {
        super(callback);
      }
    }
  };
})();
