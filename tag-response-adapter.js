(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const activeTagId = String(new URL(location.href).searchParams.get("tagId") || "").trim();
  if (!activeTagId) return;

  const upstreamFetch = window.fetch.bind(window);

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

  function isActiveTagResponse(url) {
    return url.pathname.includes(`/tag/${activeTagId}/videos`);
  }

  function apiRootFromTagUrl(url) {
    const marker = `/tag/${activeTagId}/videos`;
    const index = url.pathname.indexOf(marker);
    if (index < 0) return new URL("./", url).href;
    const rootPath = `${url.pathname.slice(0, index)}/`;
    return `${url.origin}${rootPath}`;
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
      console.warn("[TAG RESPONSE ADAPTER] 标签响应解密失败", error);
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
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");

    console.log("[TAG RESPONSE ADAPTER] 已把标签摘要转换为可展示视频", {
      tagId: activeTagId,
      count: adapted.length,
      apiRoot
    });

    return new Response(JSON.stringify(raw), {
      status: response.status,
      statusText: response.statusText,
      headers
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

    const response = await upstreamFetch(input, init);
    if (!isActiveTagResponse(url)) return response;
    return adaptTagResponse(response, url);
  };

  window.TAG_RESPONSE_ADAPTER = {
    version: "20260802-29",
    tagId: activeTagId,
    mode: "summary-to-list"
  };
})();
