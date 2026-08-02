(() => {
  "use strict";

  const ABSOLUTE_HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;

  function normalizeHttpUrl(value) {
    const input = String(value || "");
    if (!/^https?:\/\//i.test(input)) return input;

    try {
      const url = new URL(input);
      const normalizedPath = `/${url.pathname.replace(/^\/+/, "").replace(/\/{2,}/g, "/")}`;
      if (normalizedPath === url.pathname) return url.href;
      url.pathname = normalizedPath;
      return url.href;
    } catch {
      return input.replace(/^(https?:\/\/[^/]+)\/{2,}/i, "$1/");
    }
  }

  function normalizePlaylistText(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.replace(ABSOLUTE_HTTP_URL, (url) => normalizeHttpUrl(url)))
      .join("\n");
  }

  function report(original, normalized, source) {
    if (!original || original === normalized) return;
    try {
      console.info(`[playlist-url-hotfix] ${source}:`, original, "→", normalized);
      window.dispatchEvent(new CustomEvent("hq-media-url-normalized", {
        detail: { original, normalized, source }
      }));
    } catch {
      // 日志失败不能影响播放。
    }
  }

  // app.js 会把解压、改写后的 M3U8 放进 Blob，再交给 HLS.js 或 video。
  // 在 Blob 创建前统一清理其中所有绝对媒体 URL，可覆盖浏览器原生发出的
  // sec-fetch-dest: video 请求，这类请求无法被 window.fetch 拦截。
  const NativeBlob = window.Blob;
  if (typeof NativeBlob === "function" && !NativeBlob.__hqPlaylistPatched) {
    function PlaylistSafeBlob(parts, options) {
      const list = Array.isArray(parts) ? parts : [];
      const type = String(options?.type || "").toLowerCase();
      const isPlaylist = type.includes("mpegurl") || type.includes("m3u8");

      if (!isPlaylist) return new NativeBlob(list, options);

      const normalizedParts = list.map((part) => {
        if (typeof part !== "string") return part;
        const normalized = normalizePlaylistText(part);
        report(part, normalized, "playlist blob");
        return normalized;
      });

      return new NativeBlob(normalizedParts, options);
    }

    PlaylistSafeBlob.prototype = NativeBlob.prototype;
    Object.setPrototypeOf(PlaylistSafeBlob, NativeBlob);
    Object.defineProperty(PlaylistSafeBlob, "__hqPlaylistPatched", { value: true });
    window.Blob = PlaylistSafeBlob;
  }

  // HLS.js 的网络层兜底。即使某个播放列表没有经过 Blob，分片、密钥和
  // 初始化段进入 loader 前也会被归一化。
  function patchHlsLoader() {
    const Hls = window.Hls;
    const defaults = Hls?.DefaultConfig;
    if (!defaults || defaults.__hqUrlLoaderPatched) return;

    const patchLoaderClass = (LoaderClass, label) => {
      if (typeof LoaderClass !== "function" || LoaderClass.__hqUrlPatched) return LoaderClass;

      class NormalizingLoader extends LoaderClass {
        load(context, config, callbacks) {
          if (context?.url) {
            const original = context.url;
            const normalized = normalizeHttpUrl(original);
            report(original, normalized, `hls ${label}`);
            if (normalized !== original) context = { ...context, url: normalized };
          }
          return super.load(context, config, callbacks);
        }
      }

      Object.defineProperty(NormalizingLoader, "__hqUrlPatched", { value: true });
      return NormalizingLoader;
    };

    defaults.loader = patchLoaderClass(defaults.loader, "loader");
    if (defaults.fLoader) defaults.fLoader = patchLoaderClass(defaults.fLoader, "fragment loader");
    if (defaults.pLoader) defaults.pLoader = patchLoaderClass(defaults.pLoader, "playlist loader");
    Object.defineProperty(defaults, "__hqUrlLoaderPatched", { value: true });
  }

  patchHlsLoader();
  window.addEventListener("load", patchHlsLoader, { once: true });

  // 直接给 video.src 或 source.src 赋绝对地址时也清理一次。
  const mediaSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (mediaSrcDescriptor?.set && mediaSrcDescriptor?.get && !HTMLMediaElement.prototype.__hqSrcPatched) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: mediaSrcDescriptor.configurable,
      enumerable: mediaSrcDescriptor.enumerable,
      get: mediaSrcDescriptor.get,
      set(value) {
        const original = String(value || "");
        const normalized = normalizeHttpUrl(original);
        report(original, normalized, "media src");
        return mediaSrcDescriptor.set.call(this, normalized);
      }
    });
    Object.defineProperty(HTMLMediaElement.prototype, "__hqSrcPatched", { value: true });
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  if (!Element.prototype.__hqMediaAttributePatched) {
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (
        String(name).toLowerCase() === "src" &&
        (this instanceof HTMLMediaElement || this instanceof HTMLSourceElement)
      ) {
        const original = String(value || "");
        const normalized = normalizeHttpUrl(original);
        report(original, normalized, "media attribute");
        return nativeSetAttribute.call(this, name, normalized);
      }
      return nativeSetAttribute.call(this, name, value);
    };
    Object.defineProperty(Element.prototype, "__hqMediaAttributePatched", { value: true });
  }

  window.HQPlaylistUrlHotfix = {
    normalizeHttpUrl,
    normalizePlaylistText
  };
})();
