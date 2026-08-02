# Web Videos Demo

这是从 APK 1.2.75 的网络、图片和播放逻辑整理出的 GitHub Pages 静态客户端。打开网页后会自动：

1. 测试 APK 内置的 API 引导线路。
2. 按 APK 规则选线：优先采用最先返回且 `data.s >= 5` 的线路；否则按 `服务器评分 × 75% + 延迟评分 × 25%` 选择。
3. 请求 `GET sys/dmCfg?pid=PH`，取得动态 API、资源、上传和 AI 线路。
4. 调用 `POST users/signin` 自动创建游客身份，并保存服务器返回的 Token。
5. 请求 `GET videos/shortCate` 获取真实分类，再请求 `GET videos/short` 获取视频列表。
6. 使用 APK 的 AES-256-ECB-PKCS7 业务密钥解密接口数据，再进行 Base64 解码、zlib 解压和 JSON 解析。
7. 使用独立图片密钥解密 `.ceb/.geb` 视频封面和作者头像。
8. 显示作者、播放数、点赞数、评论数、收藏数等信息。
9. 通过 `users/{uid}/info` 与 `users/{uid}/videos` 展示作者主页及作品。
10. 播放时使用请求头 `m: 1` 获取压缩的 m3u8，zlib 解压后处理 HLS AES-128 密钥并交给 hls.js。
11. 下载时优先尝试服务器提供的 MP4；失败后下载当前已授权 HLS 的分片，在浏览器中解密并合并为 `.ts` 或 `.mp4` 文件。

## 部署

仓库已经包含 `.github/workflows/pages.yml`。在仓库中打开：

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

然后推送到 `main`，或在 Actions 中手动运行部署工作流。

预期地址：

```text
https://1564269628.github.io/web_videos_demo/
```

## 主要文件

- `app.js`：自动选线、游客登录、列表请求和 HLS 播放主流程。
- `diagnostics.js`：分类回退、请求与响应调试。
- `enhancements.js`：封面/头像解密、视频元数据、作者主页和下载功能。
- `enhancements.css`：增强卡片、作者弹窗、下载进度和日志自动换行。
- `config.js`：线路、接口路径和密钥配置。

## 关键配置

都在 `config.js`：

- `apiCandidates`：APK 内置的 API 引导域名。
- `aesKey`：业务接口 AES 密钥。
- `imageAesKey`：`.ceb/.geb` 图片解密密钥。
- `mediaKeyBase64`：APK 的 `assets/www/encrypt.key`，用于 HLS AES-128 分片。
- `pid`：`PH`。
- `webVersion`：`1.2.75`。

## Token

APK 中没有固定用户 Token。网页会保存一个稳定浏览器 UUID，并按 APK 的匿名登录逻辑调用 `users/signin` 获取游客 Token。Token 只保存在当前浏览器的 `localStorage`。

也可以在页面输入自己的账号 Token，或临时使用：

```text
?token=你的Token
```

不建议分享带 Token 的 URL。

## 下载说明

下载功能只使用服务器已经向当前 Token 返回的播放地址，不绕过服务端的 VIP、金币或内容权限判断。

- 若 CDN 上的 `mp4PlayURL` 可访问，会直接下载 MP4。
- 否则读取当前签名 m3u8，下载其媒体分片并按 HLS AES-128 规则解密。
- 普通 MPEG-TS 流保存为 `.ts`，大多数桌面播放器可以直接播放，也可以再用 FFmpeg 转成 MP4。
- 下载需要视频分片服务器允许浏览器跨域；较长视频会占用较多内存。

## 浏览器限制

GitHub Pages 是纯静态站点，请求能否成功还取决于服务器：

- 必须允许来自 `https://1564269628.github.io` 的 CORS 请求。
- 必须允许请求头 `t`、`k`、`token`、`version`、`m`。
- 视频分片、MP4、`.ceb/.geb` 图片也必须允许跨域读取，而不仅是允许 `<img>` 或 `<video>` 显示。
- HTTPS 证书必须受浏览器信任。裸 IP 备用线路可能因证书不匹配而失败，网页会自动尝试其他域名。
- 如果服务端只允许 Cordova 的 `file://` / WebView 来源，需要在服务端补充 GitHub Pages 域名到 CORS 白名单。

## 接口加密格式

请求 POST 数据：

```json
{
  "en": "AES-ECB-PKCS7(JSON.stringify(data))"
}
```

响应数据：

```text
response.data
→ AES-256-ECB-PKCS7 解密
→ 得到 Base64 字符串
→ Base64 解码
→ zlib inflate
→ JSON.parse
```
