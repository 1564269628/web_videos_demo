# Web Videos Demo

一个可以直接部署到 GitHub Pages 的静态视频播放器，支持：

- HLS / `.m3u8` 播放（hls.js）
- MP4 等浏览器原生格式
- 多 API 节点并发测速
- 服务器评分 75% + 网络延迟 25% 的加权选线
- 从选中 API 获取域名配置
- 多资源节点播放失败自动切换
- 本地 JSON 或远程 API 视频目录
- 手动粘贴视频地址播放
- GitHub Actions 自动部署 Pages

## 安全边界

这个仓库复现的是通用的“本地网页 + 多线路测速 + 动态资源域名 + HLS 播放”架构，不包含从第三方 APK 提取的私有域名、Token、AES 密钥或绕过鉴权的代码。

请只接入你拥有或明确获准使用的服务器和媒体内容。

## 本地运行

不要直接双击 `index.html`，请使用本地 HTTP 服务：

```bash
python -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

## 配置 API 节点

可以直接在网页的“API 节点”输入框中填写，每行一个地址；也可以编辑 `config.js`：

```js
window.VIDEO_APP_CONFIG = {
  apiCandidates: [
    "https://api-1.example.com/api/v1/",
    "https://api-2.example.com/api/v1/"
  ],
  speedtestPath: "speedtest",
  domainConfigPath: "sys/dmCfg",
  remoteCatalogPath: "videos/short"
};
```

页面会请求：

```text
GET <API基础地址>/speedtest
GET <API基础地址>/sys/dmCfg?pid=PH
```

测速响应可以是：

```json
{
  "data": {
    "s": 8
  }
}
```

其中 `s` 建议为 0 到 10。没有 `s` 时仍会按网络延迟选线。

## 域名配置格式

支持普通 JSON：

```json
{
  "data": {
    "apiDomains": [
      "https://api-1.example.com/api/v1/"
    ],
    "resDomains": [
      "https://media-1.example.com/",
      "https://media-2.example.com/"
    ]
  }
}
```

当视频目录里的 `url` 是相对路径时，例如：

```json
{
  "id": 1001,
  "title": "示例视频",
  "url": "hls/1001/index.m3u8",
  "poster": "covers/1001.jpg"
}
```

播放器会依次拼接 `resDomains`，某条 HLS 资源线路网络失败后自动尝试下一条。

## 视频目录格式

本地目录位于 `data/videos.json`。支持数组，或位于以下任意字段中：

- `data`
- `list`
- `items`
- `records`
- `rows`
- `videos`

常见字段会自动适配：

```json
{
  "items": [
    {
      "id": "demo-1",
      "title": "演示视频",
      "url": "https://example.com/video.m3u8",
      "poster": "https://example.com/poster.jpg",
      "description": "HLS"
    }
  ]
}
```

播放地址字段支持：

```text
url / playUrl / play_url / videoUrl / video_url / src
```

封面字段支持：

```text
poster / cover / coverUrl / cover_url / thumb
```

## CORS 要求

GitHub Pages 是浏览器静态站点，API、m3u8 和视频分片服务器必须允许跨域访问。服务器至少应根据实际需求返回类似：

```http
Access-Control-Allow-Origin: https://1564269628.github.io
Access-Control-Allow-Headers: Content-Type, Range
Access-Control-Expose-Headers: Content-Length, Content-Range
```

HLS 的 `.m3u8`、密钥文件和所有分片都必须允许跨域，否则浏览器会拦截。

## 部署 GitHub Pages

仓库已包含：

```text
.github/workflows/pages.yml
```

在仓库中打开：

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

然后重新运行 `Deploy GitHub Pages` 工作流，或向 `main` 分支推送一次提交。

预期地址：

```text
https://1564269628.github.io/web_videos_demo/
```

注意：仓库当前是私有仓库。GitHub Pages 对私有仓库的可用性和访问范围取决于账号方案与仓库设置。
