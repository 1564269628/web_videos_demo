(() => {
"use strict";
const config = window.VIDEO_APP_CONFIG || {};
const state = {
activeApi: "",
activeLatency: null,
activeResource: "",
token: "",
userInfo: null,
domainData: null,
catalogData: null,
videos: [],
page: Number(config.defaultVideoParams?.page || 1),
activeVideoId: "",
currentUrl: "",
hls: null,
playlistBlobUrl: "",
mediaKeyBlobUrl: ""
};
const $ = (selector) => document.querySelector(selector);
const elements = {
appTitle: $("#app-title"),
badge: $("#connection-badge"),
video: $("#video"),
playerEmpty: $("#player-empty"),
nowTitle: $("#now-title"),
nowUrl: $("#now-url"),
copyUrl: $("#copy-url"),
manualForm: $("#manual-form"),
manualUrl: $("#manual-url"),
restart: $("#restart-button"),
reloadCatalog: $("#reload-catalog"),
previousPage: $("#previous-page"),
nextPage: $("#next-page"),
pageLabel: $("#page-label"),
activeApi: $("#active-api"),
activeLatency: $("#active-latency"),
activeResource: $("#active-resource"),
videoCount: $("#video-count"),
authStatus: $("#auth-status"),
tokenInput: $("#token-input"),
saveToken: $("#save-token"),
videoList: $("#video-list"),
domainJson: $("#domain-json"),
catalogJson: $("#catalog-json"),
logOutput: $("#log-output")
};
function setBadge(text, kind = "busy") {
if (!elements.badge) return;
elements.badge.textContent = text;
elements.badge.className = `badge badge-${kind}`;
}
function safeJson(value) {
try {
return JSON.stringify(value, null, 2);
} catch {
return String(value);
}
}
function log(message, details) {
const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
let line = `[${time}] ${message}`;
if (details !== undefined) {
line += `\n${typeof details === "string" ? details : safeJson(details)}`;
}
const old = elements.logOutput?.textContent === "页面启动中…" ? "" : (elements.logOutput?.textContent || "");
if (elements.logOutput) elements.logOutput.textContent = `${line}\n${old}`.slice(0, 40000);
}
function showJson(element, value) {
if (element) element.textContent = safeJson(value);
}
function normalizeBase(value) {
const text = String(value || "").trim();
if (!text) return "";
try {
const url = new URL(text);
if (!/^https?:$/.test(url.protocol)) return "";
return url.href.endsWith("/") ? url.href : `${url.href}/`;
} catch {
return "";
}
}
function unique(values) {
return [...new Set(values.filter(Boolean))];
}
function joinUrl(base, path) {
const normalized = normalizeBase(base);
if (!normalized) throw new Error(`无效基础地址：${base}`);
return new URL(String(path || "").replace(/^\/+/, ""), normalized).href;
}
function maskToken(token) {
const value = String(token || "");
if (!value) return "无";
if (value.length <= 12) return `${value.slice(0, 3)}***`;
return `${value.slice(0, 6)}…${value.slice(-5)}`;
}
function getStoredToken() {
const queryToken = new URL(location.href).searchParams.get("token");
if (queryToken) return queryToken.trim();
return localStorage.getItem(config.storageKeys?.token || "hq-video-token") || "";
}
function setToken(token, source = "") {
state.token = String(token || "").trim();
const key = config.storageKeys?.token || "hq-video-token";
if (state.token) localStorage.setItem(key, state.token);
else localStorage.removeItem(key);
if (elements.tokenInput) elements.tokenInput.value = state.token;
if (elements.authStatus) {
elements.authStatus.textContent = state.token
? `${source || "已登录"} · ${maskToken(state.token)}`
: "未登录";
}
}
function getOrCreateUuid() {
const key = config.storageKeys?.uuid || "hq-video-device-uuid";
let uuid = localStorage.getItem(key) || "";
if (uuid) return uuid;
if (crypto?.randomUUID) uuid = crypto.randomUUID();
else uuid = `${Date.now().toString(16)}-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join("-")}`;
localStorage.setItem(key, uuid);
return uuid;
}
function assertLibraries() {
const missing = [];
if (!window.CryptoJS) missing.push("CryptoJS");
if (!window.pako) missing.push("pako");
if (!window.Hls) missing.push("hls.js");
if (missing.length) throw new Error(`依赖加载失败：${missing.join("、")}`);
}
async function fetchWithTimeout(url, options = {}, timeoutMs) {
const controller = new AbortController();
const timeout = window.setTimeout(
() => controller.abort(),
Number(timeoutMs || config.requestTimeoutMs || 10000)
);
try {
return await fetch(url, {
cache: "no-store",
credentials: "omit",
redirect: "follow",
...options,
signal: controller.signal
});
} finally {
window.clearTimeout(timeout);
}
}
function base64ToBytes(base64) {
const binary = atob(String(base64 || "").replace(/\s+/g, ""));
const bytes = new Uint8Array(binary.length);
for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
return bytes;
}
function encryptRequest(data) {
const key = CryptoJS.enc.Utf8.parse(config.aesKey);
return CryptoJS.AES.encrypt(JSON.stringify(data ?? {}), key, {
mode: CryptoJS.mode.ECB,
padding: CryptoJS.pad.Pkcs7,
blockSize: 16
}).toString();
}
function decryptResponseData(ciphertext) {
if (typeof ciphertext !== "string" || !ciphertext) return ciphertext;
const key = CryptoJS.enc.Utf8.parse(config.aesKey);
const decrypted = CryptoJS.AES.decrypt(ciphertext, key, {
mode: CryptoJS.mode.ECB,
padding: CryptoJS.pad.Pkcs7,
blockSize: 16
});
const compressedBase64 = CryptoJS.enc.Utf8.stringify(decrypted);
if (!compressedBase64) throw new Error("AES 解密结果为空，密钥或响应格式不匹配");
const compressedBytes = base64ToBytes(compressedBase64);
const jsonText = pako.inflate(compressedBytes, { to: "string" });
return JSON.parse(jsonText);
}
function decodeEnvelope(body) {
if (!body || typeof body !== "object") return body;
const decoded = Array.isArray(body) ? [...body] : { ...body };
if (typeof decoded.data === "string" && decoded.data) decoded.data = decryptResponseData(decoded.data);
return decoded;
}
async function parseJsonResponse(response) {
const text = await response.text();
if (!text) return { rawText: "", raw: {}, decoded: {} };
let raw;
try {
raw = JSON.parse(text);
} catch {
throw new Error(`服务器没有返回 JSON：${text.slice(0, 180)}`);
}
return { rawText: text, raw, decoded: decodeEnvelope(raw) };
}
function getApiHeaders(tokenOverride) {
const token = tokenOverride !== undefined ? tokenOverride : state.token;
return {
Accept: "application/json",
"Content-Type": "application/json",
t: "2",
k: "2",
token: token || "",
version: String(config.webVersion || "1.2.75")
};
}
async function apiRequest(path, options = {}) {
const method = String(options.method || "GET").toUpperCase();
const base = options.base || state.activeApi;
if (!base) throw new Error("API 线路尚未初始化");
const url = new URL(joinUrl(base, path));
Object.entries(options.params || {}).forEach(([key, value]) => {
if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
});
const requestOptions = {
method,
headers: getApiHeaders(options.token)
};
if (method !== "GET" && method !== "HEAD") {
requestOptions.body = options.noEncrypt
? JSON.stringify(options.data || {})
: JSON.stringify({ en: encryptRequest(options.data || {}) });
}
log(`${method} ${url.href}`);
const response = await fetchWithTimeout(url.href, requestOptions, options.timeoutMs);
if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
return parseJsonResponse(response);
}
function getDecodedCode(result) {
return Number(result?.decoded?.errorCode ?? result?.decoded?.code ?? 0);
}
function isTokenError(result) {
const code = getDecodedCode(result);
const message = String(result?.decoded?.message || result?.decoded?.msg || "").toLowerCase();
return code === 1003 || code === 1035 || message.includes("token error") || message.includes("token不同");
}
function latencyScore(ms) {
if (ms <= 100) return 10;
if (ms <= 250) return 7;
if (ms <= 500) return 5;
if (ms <= 700) return 3;
if (ms <= 1000) return 1;
return 0;
}
function extractServerScore(decoded) {
const value = decoded?.data?.s ?? decoded?.s ?? 0;
const number = Number(value);
return Number.isFinite(number) ? number : 0;
}
async function probeApi(base) {
const started = performance.now();
const url = joinUrl(base, config.speedtestPath || "speedtest");
const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 6500);
const elapsed = Math.round(performance.now() - started);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const result = await parseJsonResponse(response);
const serverScore = extractServerScore(result.decoded);
const weightedScore = serverScore * 0.75 + latencyScore(elapsed) * 0.25;
return { base, elapsed, serverScore, weightedScore, response: result.decoded };
}
async function chooseApi(candidates, label = "API") {
const normalized = unique(candidates.map(normalizeBase));
if (!normalized.length) throw new Error(`没有配置${label}线路`);
log(`开始测速 ${normalized.length} 条${label}线路`, normalized);
const settled = await Promise.allSettled(normalized.map(probeApi));
const successful = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
settled.forEach((item, index) => {
if (item.status === "rejected") log(`${label}线路失败：${normalized[index]}`, item.reason?.message || String(item.reason));
});
if (!successful.length) throw new Error(`所有${label}线路均不可访问，常见原因是 CORS、证书或服务器离线`);
const preferred = successful.filter((item) => item.serverScore >= 5).sort((a, b) => a.elapsed - b.elapsed)[0];
const winner = preferred || successful.sort((a, b) => b.weightedScore - a.weightedScore || a.elapsed - b.elapsed)[0];
state.activeApi = winner.base;
state.activeLatency = winner.elapsed;
if (elements.activeApi) elements.activeApi.textContent = winner.base;
if (elements.activeLatency) elements.activeLatency.textContent = `${winner.elapsed} ms`;
log(`${label}选线完成`, { winner, all: successful });
return winner;
}
async function selectBootstrapApi() {
setBadge("正在测速 API…", "busy");
const storageKey = config.storageKeys?.apiCandidates || "hq-video-api-candidates";
const stored = localStorage.getItem(storageKey);
const candidates = stored ? stored.split(/\n+/) : (config.apiCandidates || []);
await chooseApi(candidates, "引导 API");
}
function flattenDomainValues(value) {
if (Array.isArray(value)) return value.flatMap(flattenDomainValues);
if (typeof value === "string") return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
if (value && typeof value === "object") return Object.values(value).flatMap(flattenDomainValues);
return [];
}
function readDomainField(data, keys) {
for (const key of keys) {
if (data?.[key] !== undefined) return flattenDomainValues(data[key]);
}
return [];
}
async function probeResource(base) {
const started = performance.now();
const file = `${String(config.pid || "PH").toLowerCase()}.ceb`;
const response = await fetchWithTimeout(joinUrl(base, file), { method: "GET" }, config.resourceProbeTimeoutMs || 4500);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
return { base, elapsed: Math.round(performance.now() - started) };
}
async function chooseResource(domains) {
const normalized = unique(domains.map(normalizeBase));
if (!normalized.length) return "";
const settled = await Promise.allSettled(normalized.slice(0, 8).map(probeResource));
const successful = settled.filter((item) => item.status === "fulfilled").map((item) => item.value).sort((a, b) => a.elapsed - b.elapsed);
if (successful.length) {
log("资源线路测速完成", successful);
return successful[0].base;
}
log("资源线路无法在浏览器中测速，使用服务器下发的第一条线路");
return normalized[0];
}
async function loadDomainConfig() {
setBadge("正在获取域名配置…", "busy");
const result = await apiRequest(config.domainConfigPath || "sys/dmCfg", {
params: { pid: config.pid || "PH" },
timeoutMs: 12000,
token: ""
});
state.domainData = result.decoded;
showJson(elements.domainJson, { raw: result.raw, decoded: result.decoded });
const payload = result.decoded?.data ?? result.decoded;
const apiDomains = readDomainField(payload, ["apiDomains", "apiUrls"]);
const resourceDomains = readDomainField(payload, ["resDomains", "resourceDomains", "resourceUrls", "resUrls"]);
const webDomains = readDomainField(payload, ["webDomains", "webUrls"]);
const uploadDomains = readDomainField(payload, ["uploadUrl", "uploadUrls", "uploadDomains"]);
const aiDomains = readDomainField(payload, ["aiDomains", "aiUrls"]);
state.activeResource = await chooseResource(resourceDomains);
if (elements.activeResource) elements.activeResource.textContent = state.activeResource || "服务器未下发";
log("域名配置解密成功", {
apiDomains,
resourceDomains,
selectedResource: state.activeResource,
webDomains,
uploadDomains,
aiDomains
});
if (apiDomains.length && config.useDynamicApiDomains !== false) {
try {
await chooseApi(unique([state.activeApi, ...apiDomains]), "动态 API");
} catch (error) {
log("动态 API 线路不可用，继续使用引导线路", error.message);
}
}
}
async function validateStoredToken() {
if (!state.token) return false;
try {
const result = await apiRequest(config.userInfoPath || "users/info", { timeoutMs: 10000 });
if (getDecodedCode(result) === 0) {
state.userInfo = result.decoded?.data || null;
setToken(state.token, "已有 Token");
log("已有 Token 验证成功", {
uid: state.userInfo?.uid ?? state.userInfo?.id,
username: state.userInfo?.username,
vipLevel: state.userInfo?.vipLevel
});
return true;
}
log("已有 Token 验证失败", result.decoded);
if (isTokenError(result)) setToken("");
return false;
} catch (error) {
log("Token 验证请求失败，将尝试游客登录", error.message);
return false;
}
}
async function anonymousSignin(retry = true) {
setBadge("正在游客登录…", "busy");
if (elements.authStatus) elements.authStatus.textContent = "正在获取游客 Token…";
const params = new URL(location.href).searchParams;
const payload = {
verifyType: "anonymous",
uuid: getOrCreateUuid(),
channel: params.get("channel") || config.defaultChannel || "",
inviteCode: params.get("inviteCode") || params.get("invite") || config.defaultInviteCode || "",
captcha: localStorage.getItem(config.storageKeys?.captchaCode || "hq-video-captcha-code") || "",
key: localStorage.getItem(config.storageKeys?.captchaKey || "hq-video-captcha-key") || "",
pid: config.pid || "PH",
url: window.location.href
};
const result = await apiRequest(config.signinPath || "users/signin", {
method: "POST",
data: payload,
token: "",
timeoutMs: 15000
});
const code = getDecodedCode(result);
const token = result.decoded?.data?.resToken?.token || "";
if (code === 0 && token) {
setToken(token, "游客登录");
log("游客登录成功", {
token: maskToken(token),
newUser: result.decoded?.data?.newUser,
uuid: payload.uuid
});
return result;
}
if (code === 1071 && retry) {
localStorage.removeItem(config.storageKeys?.captchaCode || "hq-video-captcha-code");
localStorage.removeItem(config.storageKeys?.captchaKey || "hq-video-captcha-key");
log("验证码状态失效，清理后重试游客登录");
return anonymousSignin(false);
}
throw new Error(`游客登录失败：${result.decoded?.message || `errorCode ${code}`}`);
}
async function ensureAuthenticated() {
const stored = getStoredToken();
setToken(stored, stored ? "本地 Token" : "");
if (await validateStoredToken()) return;
setToken("");
await anonymousSignin();
await validateStoredToken();
}
function resolveUrl(value, bases = []) {
const text = String(value || "").trim();
if (!text) return "";
try {
return new URL(text).href;
} catch {
for (const base of bases) {
try {
return joinUrl(base, text);
} catch {
}
}
}
return "";
}
function appendPlaybackParams(url) {
if (!url) return "";
try {
const parsed = new URL(url);
if (config.pid && !parsed.searchParams.has("pid")) parsed.searchParams.set("pid", config.pid);
if (state.activeResource && !parsed.searchParams.has("domain")) parsed.searchParams.set("domain", state.activeResource);
return parsed.href;
} catch {
return url;
}
}
function findArray(value, depth = 0) {
if (depth > 5 || value == null) return [];
if (Array.isArray(value)) return value;
if (typeof value !== "object") return [];
for (const key of ["videoInfo", "videos", "list", "items", "records", "rows", "data"]) {
if (value[key] !== undefined) {
const result = findArray(value[key], depth + 1);
if (result.length) return result;
}
}
return [];
}
function normalizeVideo(item, index) {
const video = item?.video && typeof item.video === "object" ? item.video : item;
const rawUrl = item?.url || video?.url || video?.playUrl || video?.playURL || video?.videoUrl || video?.videoURL || video?.src || "";
const resolved = resolveUrl(rawUrl, [state.activeApi, state.activeResource]);
const url = item?.video ? appendPlaybackParams(resolved) : resolved;
const coverRaw = video?.coverURL || video?.coverUrl || video?.cover || video?.poster || video?.thumb || "";
const cover = resolveUrl(coverRaw, [state.activeResource, state.activeApi]);
const title = video?.title || video?.name || video?.videoName || video?.description || `视频 ${index + 1}`;
const duration = video?.duration || video?.playTime || video?.time || "";
const id = String(video?.id ?? video?.vid ?? video?.videoId ?? item?.id ?? `video-${state.page}-${index}`);
return {
id,
title: String(title),
url,
cover,
duration: String(duration || ""),
protectedPlaylist: Boolean(item?.video) || !/\.(mp4|webm|ogg)(?:$|[?#])/i.test(url),
raw: item
};
}
function extractVideos(decoded) {
const payload = decoded?.data ?? decoded;
const source = Array.isArray(payload?.videoInfo) ? payload.videoInfo : findArray(payload);
return source.map(normalizeVideo).filter((video) => video.url);
}
async function loadVideos(retryAuth = true) {
setBadge(`正在加载第 ${state.page} 页…`, "busy");
if (elements.reloadCatalog) elements.reloadCatalog.disabled = true;
if (elements.pageLabel) elements.pageLabel.textContent = `第 ${state.page} 页`;
if (elements.videoList) elements.videoList.innerHTML = '<div class="empty-list">正在请求并解密视频数据…</div>';
try {
const params = {
...(config.defaultVideoParams || {}),
page: state.page,
pid: config.pid || "PH"
};
const result = await apiRequest(config.videoCatalogPath || "videos/short", { params, timeoutMs: 15000 });
if (isTokenError(result) && retryAuth) {
log("视频接口返回 Token 失效，自动重新游客登录", result.decoded);
setToken("");
await anonymousSignin();
return loadVideos(false);
}
state.catalogData = result.decoded;
showJson(elements.catalogJson, { raw: result.raw, decoded: result.decoded });
const code = getDecodedCode(result);
if (code !== 0) throw new Error(result.decoded?.message || `视频接口 errorCode ${code}`);
state.videos = extractVideos(result.decoded);
if (elements.videoCount) elements.videoCount.textContent = String(state.videos.length);
renderVideos();
setBadge(`已连接 · ${state.activeLatency} ms`, "ok");
log(`视频接口解密完成，第 ${state.page} 页共 ${state.videos.length} 条`, result.decoded);
} catch (error) {
state.videos = [];
if (elements.videoCount) elements.videoCount.textContent = "0";
renderVideos(error.message);
setBadge("视频数据加载失败", "error");
log("视频数据加载失败", error.message);
} finally {
if (elements.reloadCatalog) elements.reloadCatalog.disabled = false;
}
}
function placeholderCover() {
return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='400'%3E%3Crect width='100%25' height='100%25' fill='%2311182a'/%3E%3Ccircle cx='320' cy='200' r='66' fill='%237d8cff' opacity='.85'/%3E%3Cpath d='M300 160l70 40-70 40z' fill='white'/%3E%3C/svg%3E";
}
function renderVideos(errorMessage = "") {
if (!elements.videoList) return;
elements.videoList.replaceChildren();
if (!state.videos.length) {
const empty = document.createElement("div");
empty.className = "empty-list";
empty.textContent = errorMessage || "服务器本页没有返回可识别的视频。";
elements.videoList.append(empty);
return;
}
state.videos.forEach((video) => {
const button = document.createElement("button");
button.type = "button";
button.className = `video-card${state.activeVideoId === video.id ? " active" : ""}`;
const cover = document.createElement("div");
cover.className = "video-cover";
const image = document.createElement("img");
image.loading = "lazy";
image.alt = "";
image.referrerPolicy = "no-referrer";
image.src = video.cover && !/\.ceb(?:$|[?#])/i.test(video.cover) ? video.cover : placeholderCover();
image.onerror = () => { image.src = placeholderCover(); };
cover.append(image);
if (video.duration) {
const badge = document.createElement("span");
badge.textContent = video.duration;
cover.append(badge);
}
const meta = document.createElement("div");
meta.className = "video-meta";
const title = document.createElement("strong");
title.textContent = video.title;
const subtitle = document.createElement("small");
subtitle.textContent = video.protectedPlaylist ? "加密 HLS" : "视频文件";
meta.append(title, subtitle);
button.append(cover, meta);
button.addEventListener("click", () => playVideo(video));
elements.videoList.append(button);
});
}
function destroyPlayerObjects() {
if (state.hls) {
state.hls.destroy();
state.hls = null;
}
if (state.playlistBlobUrl) {
URL.revokeObjectURL(state.playlistBlobUrl);
state.playlistBlobUrl = "";
}
if (state.mediaKeyBlobUrl) {
URL.revokeObjectURL(state.mediaKeyBlobUrl);
state.mediaKeyBlobUrl = "";
}
}
function getMediaKeyBlobUrl() {
if (!state.mediaKeyBlobUrl) {
const bytes = base64ToBytes(config.mediaKeyBase64);
state.mediaKeyBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
}
return state.mediaKeyBlobUrl;
}
function rewritePlaylist(playlist, sourceUrl) {
const keyUrl = getMediaKeyBlobUrl();
return playlist.split(/\r?\n/).map((line) => {
const trimmed = line.trim();
if (!trimmed) return line;
if (trimmed.startsWith("#EXT-X-KEY")) {
if (/URI="[^"]*"/i.test(line)) return line.replace(/URI="[^"]*"/i, `URI="${keyUrl}"`);
return `${line},URI="${keyUrl}"`;
}
if (trimmed.startsWith("#")) {
return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
try { return `URI="${new URL(uri, sourceUrl).href}"`; }
catch { return match; }
});
}
try { return new URL(trimmed, sourceUrl).href; }
catch { return line; }
}).join("\n");
}
async function fetchProtectedPlaylist(url) {
const response = await fetchWithTimeout(url, { headers: { m: "1" } }, 15000);
if (!response.ok) throw new Error(`播放列表请求失败：HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
let playlist;
try {
playlist = pako.inflate(bytes, { to: "string" });
log("m3u8 zlib 解压成功", { compressedBytes: bytes.byteLength, textLength: playlist.length });
} catch {
playlist = new TextDecoder("utf-8").decode(bytes);
log("播放列表不是 zlib 数据，按普通文本处理");
}
if (!playlist.includes("#EXTM3U")) throw new Error("服务器返回内容不是 HLS 播放列表");
return rewritePlaylist(playlist, url);
}
async function attachHls(source) {
if (elements.video.canPlayType("application/vnd.apple.mpegurl")) {
elements.video.src = source;
await elements.video.play().catch(() => undefined);
return;
}
if (!Hls.isSupported()) throw new Error("当前浏览器不支持 HLS/MSE");
const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 60 });
state.hls = hls;
hls.attachMedia(elements.video);
hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source));
hls.on(Hls.Events.MANIFEST_PARSED, () => elements.video.play().catch(() => undefined));
hls.on(Hls.Events.ERROR, (_event, data) => {
log("HLS 播放事件", data);
if (!data.fatal) return;
if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
else hls.destroy();
});
}
async function playVideo(video) {
destroyPlayerObjects();
elements.video.pause();
elements.video.removeAttribute("src");
elements.video.load();
state.activeVideoId = video.id;
state.currentUrl = video.url;
if (elements.nowTitle) elements.nowTitle.textContent = video.title;
if (elements.nowUrl) elements.nowUrl.textContent = video.url;
if (elements.copyUrl) elements.copyUrl.disabled = false;
if (elements.playerEmpty) elements.playerEmpty.hidden = true;
renderVideos();
setBadge("正在加载视频…", "busy");
try {
let source = video.url;
if (video.protectedPlaylist) {
const playlist = await fetchProtectedPlaylist(video.url);
state.playlistBlobUrl = URL.createObjectURL(new Blob([playlist], { type: "application/vnd.apple.mpegurl" }));
source = state.playlistBlobUrl;
}
if (/\.m3u8(?:$|[?#])/i.test(source) || source.startsWith("blob:")) await attachHls(source);
else {
elements.video.src = source;
await elements.video.play().catch(() => undefined);
}
setBadge("视频已加载", "ok");
} catch (error) {
setBadge("视频播放失败", "error");
log("视频播放失败", error.message);
}
}
async function initialize() {
try {
assertLibraries();
setBadge("正在自动连接…", "busy");
if (elements.restart) elements.restart.disabled = true;
await selectBootstrapApi();
await loadDomainConfig();
await ensureAuthenticated();
await loadVideos();
setBadge(`已连接 · ${state.activeLatency} ms`, "ok");
} catch (error) {
setBadge("初始化失败", "error");
log("初始化失败", error.message);
if (elements.videoList) elements.videoList.innerHTML = `<div class="empty-list">${String(error.message).replace(/[<>]/g, "")}</div>`;
} finally {
if (elements.restart) elements.restart.disabled = false;
}
}
function bindEvents() {
elements.restart?.addEventListener("click", initialize);
elements.reloadCatalog?.addEventListener("click", () => loadVideos());
elements.previousPage?.addEventListener("click", () => {
if (state.page <= 1) return;
state.page -= 1;
loadVideos();
});
elements.nextPage?.addEventListener("click", () => {
state.page += 1;
loadVideos();
});
elements.saveToken?.addEventListener("click", async () => {
setToken(elements.tokenInput?.value || "", elements.tokenInput?.value ? "手动 Token" : "");
state.page = 1;
await ensureAuthenticated();
await loadVideos();
});
elements.manualForm?.addEventListener("submit", (event) => {
event.preventDefault();
const url = elements.manualUrl?.value.trim();
if (!url) return;
playVideo({
id: "manual",
title: "手动播放",
url,
cover: "",
duration: "",
protectedPlaylist: !/\.(mp4|webm|ogg)(?:$|[?#])/i.test(url)
});
});
elements.copyUrl?.addEventListener("click", () => navigator.clipboard.writeText(state.currentUrl || ""));
document.querySelectorAll(".copy-json").forEach((button) => {
button.addEventListener("click", () => {
const target = document.getElementById(button.dataset.target || "");
navigator.clipboard.writeText(target?.textContent || "");
});
});
window.addEventListener("beforeunload", destroyPlayerObjects);
}
function boot() {
if (elements.appTitle && config.appName) elements.appTitle.textContent = config.appName;
const stored = getStoredToken();
setToken(stored, stored ? "本地 Token" : "");
bindEvents();
if (config.autoStart !== false) initialize();
}
boot();
})();
