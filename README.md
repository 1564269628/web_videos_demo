# Web Videos Demo

这是从 APK 1.2.75 的网络与播放逻辑整理出的 GitHub Pages 静态客户端。打开网页后会自动：

1. 测试 APK 内置的 5 条 API 引导线路。
2. 按 APK 规则选线：优先采用最先返回且 `data.s >= 5` 的线路；否则按 `服务器评分 × 75% + 延迟评分 × 25%` 选择。
3. 请求 `GET sys/dmCfg?pid=PH`。
4. 使用 APK 的 AES-256-ECB-PKCS7 密钥解密 `data`，再进行 Base64 解码、zlib 解压和 JSON 解析。
5. 从服务器配置中选择资源线路。
6. 请求 `GET videos/short` 并展示解密后的原始数据和视频卡片。
7. 播放时使用请求头 `m: 1` 获取压缩的 m3u8，zlib 解压后替换 HLS AES-128 密钥并交给 hls.js 播放。

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

## 关键配置

都在 `config.js`：

- `apiCandidates`：APK 内置的 API 引导域名。
- `aesKey`：业务接口 AES 密钥。
- `mediaKeyBase64`：APK 的 `assets/www/encrypt.key`。
- `pid`：`PH`。
- `webVersion`：`1.2.75`。

## Token

APK 中没有硬编码的用户 Token。Token 是登录后动态生成并保存在本地存储中的。因此网页默认使用空 Token 访问匿名接口；需要账号接口时，可在网页 Token 输入框中粘贴自己的 Token。Token 只保存在当前浏览器的 `localStorage`。

也支持临时 URL 参数：

```text
?token=你的Token
```

不建议分享带 Token 的 URL。

## 浏览器限制

GitHub Pages 是纯静态站点，请求能否成功还取决于服务器：

- 必须允许来自 `https://1564269628.github.io` 的 CORS 请求。
- 必须允许请求头 `t`、`k`、`token`、`version`、`m`。
- HTTPS 证书必须受浏览器信任。两个裸 IP 备用线路可能因证书不匹配而失败，网页会自动尝试其他域名。
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
