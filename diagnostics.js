(() => {
  "use strict";

  const config = window.VIDEO_APP_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  const records = [];
  let categories = [];
  let selectedCategoryId = localStorage.getItem(config.storageKeys?.categoryId || "hq-video-category-id") || "";
  const maxRecords = Number(config.debugRequestLimit || 20);

  const style = document.createElement("style");
  style.textContent = `
    .category-control{display:flex;align-items:center;gap:8px;color:#98a2ba;font-size:.82rem}
    .category-control span{white-space:nowrap}
    .category-control select{width:auto;min-width:180px;padding:.62rem .75rem;color:#f5f7ff;background:rgba(5,8,16,.9);border:1px solid rgba(255,255,255,.09);border-radius:10px}
    #request-json{height:560px}
    @media(max-width:720px){.category-control{width:100%}.category-control select{flex:1;min-width:0}}
  `;
  document.head.append(style);

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function maskToken(token) {
    const value = String(token || "");
    if (!value) return "";
    return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-5)}` : `${value.slice(0, 3)}***`;
  }

  function normalizeHeaders(headersLike) {
    const headers = new Headers(headersLike || {});
    const result = {};
    headers.forEach((value, key) => {
      result[key] = key.toLowerCase() === "token" ? maskToken(value) : value;
    });
    return result;
  }

  function decryptCipher(ciphertext, compressed) {
    if (!ciphertext || !window.CryptoJS) return ciphertext;
    const key = CryptoJS.enc.Utf8.parse(config.aesKey);
    const result = CryptoJS.AES.decrypt(ciphertext, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
      blockSize: 16
    });
    const text = CryptoJS.enc.Utf8.stringify(result);
    if (!text) throw new Error("AES 解密结果为空");
    if (!compressed) return JSON.parse(text);
    const binary = atob(text.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(pako.inflate(bytes, { to: "string" }));
  }

  function decodeEnvelope(raw) {
    if (!raw || typeof raw !== "object") return raw;
    const decoded = Array.isArray(raw) ? [...raw] : { ...raw };
    if (typeof decoded.data === "string" && decoded.data) {
      decoded.data = decryptCipher(decoded.data, true);
    }
    return decoded;
  }

  function inspectRequestBody(body) {
    if (!body || typeof body !== "string") return body || undefined;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.en === "string") {
        return {
          encrypted: parsed,
          decrypted: decryptCipher(parsed.en, false)
        };
      }
      return parsed;
    } catch {
      return body;
    }
  }

  async function inspectResponse(response) {
    const text = await response.clone().text();
    if (!text) return { rawText: "", raw: {}, decoded: {} };
    try {
      const raw = JSON.parse(text);
      return { rawText: text, raw, decoded: decodeEnvelope(raw) };
    } catch (error) {
      return { rawText: text.slice(0, 4000), parseError: error.message };
    }
  }

  function getOrCreatePanel(id, label, title) {
    let pre = document.getElementById(id);
    if (pre) return pre;
    const grid = document.querySelector(".data-grid");
    if (!grid) return null;
    const article = document.createElement("article");
    article.className = "panel data-panel";
    article.innerHTML = `
      <div class="section-heading">
        <div><p class="label">${label}</p><h2>${title}</h2></div>
        <button class="ghost-button" type="button">复制 JSON</button>
      </div>
      <pre id="${id}">等待请求…</pre>`;
    article.querySelector("button").addEventListener("click", () => {
      navigator.clipboard.writeText(article.querySelector("pre").textContent || "");
    });
    grid.append(article);
    return article.querySelector("pre");
  }

  function renderRecords() {
    const pre = getOrCreatePanel("request-json", "NETWORK DEBUG", "完整接口请求与响应");
    if (pre) pre.textContent = safeJson(records);
  }

  function addRecord(record) {
    records.unshift(record);
    records.splice(maxRecords);
    renderRecords();
  }

  function normalizedCategories(decoded) {
    const source = decoded?.data?.categories;
    if (!Array.isArray(source)) return [];
    return source.map((item, index) => ({
      id: String(item?.categorieId ?? item?.categoryId ?? item?.id ?? ""),
      name: String(item?.name || item?.title || `分类 ${index + 1}`),
      raw: item
    })).filter((item) => item.id);
  }

  function renderCategories(payload) {
    const pre = getOrCreatePanel("category-json", "videos/shortCate", "短视频分类数据");
    if (pre) pre.textContent = safeJson(payload);

    let select = document.getElementById("category-select");
    if (!select) {
      const toolbar = document.querySelector(".library-panel .toolbar");
      if (toolbar) {
        const label = document.createElement("label");
        label.className = "category-control";
        label.innerHTML = '<span>分类</span><select id="category-select"></select>';
        toolbar.prepend(label);
        select = label.querySelector("select");
      }
    }
    if (!select) return;
    select.replaceChildren();
    categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = `${category.name} (${category.id})`;
      select.append(option);
    });
    select.disabled = !categories.length;
    select.value = selectedCategoryId;
    if (!select.dataset.bound) {
      select.dataset.bound = "1";
      select.addEventListener("change", () => {
        localStorage.setItem(config.storageKeys?.categoryId || "hq-video-category-id", select.value);
        location.reload();
      });
    }
  }

  function isShortVideoUrl(url) {
    return /\/videos\/short\/?$/i.test(url.pathname);
  }

  function categoryEndpoint(videoUrl) {
    const url = new URL(videoUrl.href);
    url.pathname = url.pathname.replace(/\/videos\/short\/?$/i, "/videos/shortCate");
    url.search = "";
    url.searchParams.set("pid", config.pid || "PH");
    return url;
  }

  async function loadCategories(videoUrl, init) {
    if (categories.length) return categories;
    const url = categoryEndpoint(videoUrl);
    const started = performance.now();
    const response = await originalFetch(url.href, {
      ...init,
      method: "GET",
      body: undefined,
      cache: "no-store"
    });
    const inspected = await inspectResponse(response);
    categories = normalizedCategories(inspected.decoded);
    const query = new URL(location.href).searchParams;
    const preferred = query.get("categorieId") || query.get("categoryId") || selectedCategoryId;
    selectedCategoryId = categories.some((item) => item.id === preferred) ? preferred : (categories[0]?.id || "");
    if (selectedCategoryId) localStorage.setItem(config.storageKeys?.categoryId || "hq-video-category-id", selectedCategoryId);
    const record = {
      time: new Date().toISOString(),
      purpose: "自动获取短视频分类",
      method: "GET",
      url: url.href,
      request: { headers: normalizeHeaders(init?.headers) },
      response: {
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        ...inspected
      },
      selectedCategoryId,
      categories
    };
    addRecord(record);
    renderCategories(record);
    return categories;
  }

  function videoInfoCount(decoded) {
    const list = decoded?.data?.videoInfo;
    return Array.isArray(list) ? list.length : 0;
  }

  async function fetchAndInspect(url, init, extra = {}) {
    const started = performance.now();
    try {
      const response = await originalFetch(url, init);
      const inspected = await inspectResponse(response);
      const record = {
        time: new Date().toISOString(),
        method: String(init?.method || "GET").toUpperCase(),
        url: String(url),
        request: {
          headers: normalizeHeaders(init?.headers),
          body: inspectRequestBody(init?.body)
        },
        response: {
          status: response.status,
          statusText: response.statusText,
          elapsedMs: Math.round(performance.now() - started),
          ...inspected
        },
        ...extra
      };
      addRecord(record);
      return { response, inspected, record };
    } catch (error) {
      addRecord({
        time: new Date().toISOString(),
        method: String(init?.method || "GET").toUpperCase(),
        url: String(url),
        request: { headers: normalizeHeaders(init?.headers), body: inspectRequestBody(init?.body) },
        error: { name: error.name, message: error.message, elapsedMs: Math.round(performance.now() - started) },
        ...extra
      });
      throw error;
    }
  }

  window.fetch = async (input, init = {}) => {
    const requestUrl = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!isShortVideoUrl(requestUrl)) {
      return (await fetchAndInspect(input, init)).response;
    }

    await loadCategories(requestUrl, init);
    const page = Number(requestUrl.searchParams.get("page") || 1);
    const candidateIds = [
      selectedCategoryId,
      ...categories.map((item) => item.id)
    ].filter((value, index, array) => value && array.indexOf(value) === index);
    if (!candidateIds.length) candidateIds.push("");
    const limit = page === 1 ? Number(config.categoryFallbackLimit || 8) : 1;
    let lastResponse = null;

    for (const categoryId of candidateIds.slice(0, limit)) {
      const url = new URL(requestUrl.href);
      url.searchParams.set("pageSize", String(config.defaultVideoParams?.pageSize || 10));
      url.searchParams.set("categorieId", categoryId);
      url.searchParams.set("pid", config.pid || "PH");
      const result = await fetchAndInspect(url.href, init, {
        purpose: "短视频分类请求",
        categoryId,
        categoryName: categories.find((item) => item.id === categoryId)?.name || ""
      });
      lastResponse = result.response;
      if (result.inspected.decoded?.errorCode !== 0 || videoInfoCount(result.inspected.decoded) > 0 || page > 1) {
        selectedCategoryId = categoryId;
        localStorage.setItem(config.storageKeys?.categoryId || "hq-video-category-id", categoryId);
        renderCategories({ categories, selectedCategoryId, note: "当前分类" });
        return result.response;
      }
    }
    return lastResponse;
  };

  renderRecords();
})();
