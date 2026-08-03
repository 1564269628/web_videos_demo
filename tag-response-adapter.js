(() => {
  "use strict";

  const VERSION = "20260802-30";
  const config = window.VIDEO_APP_CONFIG || {};
  const activeTagId = String(new URL(location.href).searchParams.get("tagId") || "").trim();
  if (!activeTagId) return;

  const upstreamFetch = window.fetch.bind(window);

  function uiLog(message, details) {
    console.log(`[TAG RESPONSE ADAPTER ${VERSION}] ${message}`, details || "");
    const output = document.querySelector("#log-output");
    if (!output) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
    output.textContent = `[${time}] [标签适配] ${message}${suffix}\n${output.textContent || ""}`.slice(0, 180000);
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function decryptData(ciphertext) {
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const decrypted = CryptoJS.AES.decrypt(ciphertext, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
    if (!compressedBase64) throw new Error("AES 解密结果为空");
    const jsonText = pako.inflate(base64ToBytes(compressedBase64), { to: "string" });
    return JSON.parse(jsonText);
  }

  function encryptData(value) {
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const compressed = pako.deflate(JSON.stringify(value));
    const compressedBase64 = bytesToBase64(compressed);
    return CryptoJS.AES.encrypt(compressedBase64, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    }).toString();
  }

  function decodeEnvelope(raw) {
    if (!raw || typeof raw !== "object") return raw;
    if (typeof raw.data !== "string" || !raw.data) return raw;
    return { ...raw, data: decryptData(raw.data) };
  }

  function apiHeaders(extra = {}) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      t: "2",
      k: "2",
      token: localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "",
      version: String(config.webVersion || "1.2.75"),
      ...extra
    };
  }

  function isActiveTagResponse(url) {
    return url.pathname.includes(`/tag/${activeTagId}/videos`);
  }

  function isSyntheticDetail(url) {
    return url.searchParams.get("tagSummary") === "1" && /\/videos\/[^/]+\/?$/i.test(url.pathname);
  }

  function apiRootFromTagUrl(url) {
    const marker = `/tag/${activeTagId}/videos`;
    const index = url.pathname.indexOf(marker);
    if (index < 0) return new URL("./", url).href;
    const rootPath = `${url.pathname.slice(0, index)}/`;
    return `${url.origin}${rootPath}`;
  }

  function apiRootFromDetailUrl(url) {
    const match = url.pathname.match(/^(.*\/api\/v\d+\/)videos\//i);
    if (match) return `${url.origin}${match[1]}`;
    return new URL("../", url).href;
  }

  function responseWithJson(response, value) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(value), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  async function adaptTagResponse(response, requestUrl) {
    if (!response.ok) return response;

    let raw;
    try {
      raw = JSON.parse(await response.clone().text());
    } catch {
      return response;
    }
    if (!raw || typeof raw.data !== "string" || !raw.data) return response;

    let decoded;
    try {
      decoded = decryptData(raw.data);
    } catch (error) {
      uiLog("标签响应解密失败", { error: error.message || String(error) });
      return response;
    }
    if (!Array.isArray(decoded)) return response;

    const apiRoot = apiRootFromTagUrl(requestUrl);
    const adapted = decoded.map((item) => {
      const id = String(item?.id ?? item?.videoId ?? item?.vid ?? "").trim();
      if (!id) return item;
      return {
        ...item,
        url: new URL(`videos/${encodeURIComponent(id)}?tagSummary=1`, apiRoot).href,
        __tagSummary: true,
        __tagId: activeTagId
      };
    });

    raw.data = encryptData(adapted);
    uiLog("标签摘要已转换为首页可展示视频", {
      tagId: activeTagId,
      count: adapted.length,
      note: "点击视频时再按 ID 请求详情"
    });
    return responseWithJson(response, raw);
  }

  function collectMediaCandidates(value, output = [], depth = 0) {
    if (depth > 8 || value == null) return output;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return output;
      if (/\.(?:m3u8)(?:$|[?#])/i.test(text) || /(?:playUrl|videoUrl|playlist)/i.test(text)) {
        output.push(text);
      }
      return output;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectMediaCandidates(item, output, depth + 1));
      return output;
    }
    if (typeof value !== "object") return output;

    const preferredKeys = [
      "url", "playUrl", "playURL", "videoUrl", "videoURL", "m3u8", "m3u8Url",
      "playlistUrl", "playlistURL", "playPath", "videoPath"
    ];
    preferredKeys.forEach((key) => {
      if (typeof value[key] === "string") output.push(value[key].trim());
    });
    Object.values(value).forEach((item) => collectMediaCandidates(item, output, depth + 1));
    return [...new Set(output.filter((item) => item && !/\.(?:ceb|geb|jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(item)))];
  }

  function mediaUrlCandidates(raw, detailUrl) {
    if (/^https?:\/\//i.test(raw)) return [raw];
    const relative = String(raw || "").replace(/^\/+/, "");
    const apiRoot = apiRootFromDetailUrl(detailUrl);
    const activeApi = String(document.querySelector("#active-api")?.textContent || "").trim();
    const activeResource = String(document.querySelector("#active-resource")?.textContent || "").trim();
    const bases = [activeApi, activeResource, apiRoot].filter((item) => /^https?:\/\//i.test(item));
    const urls = [];
    for (const base of bases) {
      try {
        const normalized = base.endsWith("/") ? base : `${base}/`;
        urls.push(new URL(relative, normalized).href);
      } catch {
        // 尝试下一条基础线路。
      }
    }
    return [...new Set(urls)];
  }

  async function looksLikePlaylist(response) {
    try {
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      let text = "";
      try {
        text = pako.inflate(bytes, { to: "string" });
      } catch {
        text = new TextDecoder("utf-8").decode(bytes);
      }
      return text.includes("#EXTM3U");
    } catch {
      return false;
    }
  }

  async function resolveSyntheticDetail(detailRequestUrl) {
    const detailUrl = new URL(detailRequestUrl.href);
    detailUrl.searchParams.delete("tagSummary");

    const detailResponse = await upstreamFetch(detailUrl.href, {
      method: "GET",
      headers: apiHeaders(),
      cache: "no-store",
      credentials: "omit"
    });
    if (!detailResponse.ok) {
      uiLog("视频详情请求失败", { url: detailUrl.href, status: detailResponse.status });
      return detailResponse;
    }

    let decoded;
    try {
      const raw = JSON.parse(await detailResponse.clone().text());
      decoded = decodeEnvelope(raw);
      const code = Number(decoded?.errorCode ?? 0);
      if (code !== 0) throw new Error(decoded?.message || `errorCode ${code}`);
    } catch (error) {
      uiLog("视频详情解析失败", { url: detailUrl.href, error: error.message || String(error) });
      return new Response(`视频详情解析失败：${error.message || error}`, { status: 502 });
    }

    const rawCandidates = collectMediaCandidates(decoded?.data ?? decoded);
    uiLog("已取得标签视频详情", {
      videoId: detailUrl.pathname.split("/").filter(Boolean).pop(),
      candidateCount: rawCandidates.length,
      candidates: rawCandidates.slice(0, 8)
    });

    const errors = [];
    for (const rawCandidate of rawCandidates) {
      for (const mediaUrl of mediaUrlCandidates(rawCandidate, detailUrl)) {
        try {
          const response = await upstreamFetch(mediaUrl, {
            method: "GET",
            headers: apiHeaders({ Accept: "*/*", m: "1" }),
            cache: "no-store",
            credentials: "omit"
          });
          if (!response.ok) {
            errors.push(`${mediaUrl}: HTTP ${response.status}`);
            continue;
          }
          if (await looksLikePlaylist(response)) {
            uiLog("标签视频播放列表解析成功", { mediaUrl });
            return response;
          }
          errors.push(`${mediaUrl}: 返回内容不是 M3U8`);
        } catch (error) {
          errors.push(`${mediaUrl}: ${error.message || error}`);
        }
      }
    }

    uiLog("标签视频详情中没有可用播放列表", { errors: errors.slice(0, 12) });
    return new Response("标签视频详情中没有找到可用的 HLS 播放地址", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  window.fetch = async function tagResponseFetch(input, init) {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return upstreamFetch(input, init);
    }

    if (isSyntheticDetail(url)) return resolveSyntheticDetail(url);

    const response = await upstreamFetch(input, init);
    if (!isActiveTagResponse(url)) return response;
    return adaptTagResponse(response, url);
  };

  window.TAG_RESPONSE_ADAPTER = {
    version: VERSION,
    tagId: activeTagId,
    mode: "summary-list-and-lazy-detail"
  };
})();
