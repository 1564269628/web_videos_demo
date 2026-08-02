# 全部作者归档预览

分支：`feature/archive-center-v2-preview`

预览地址：`/previews/archive-center-v2/`

本预览只保留一条归档流程：

1. 只能选择归档总目录，例如 `F:\tools\short_videos`
2. 程序只扫描总目录下一层的全部作者文件夹
3. 每个有效作者目录必须包含 `author.json` 和 `works.json`
4. 从每个作者目录读取 `works/` 和 `archive-index.json`，识别已下载与未完成作品
5. 汇总全部作者作品，按视频 ID 或“规范化标题 + 时长”跨作者去重
6. 统一加入多视频并发下载队列，单视频内部并发下载 HLS 分片
7. 已下载的 MP4/TS、封面、标题、标签和作者信息可在归档中心内浏览与播放

预览页不再加载单作者归档中心、单作者目录恢复、单作者文件夹选择器、首页作者扫描、DOM 观察器补丁、gzip 自解压下载器或恢复脚本。

主要文件：

- `archive-all-authors.js`
- `archive-all-authors.css`
- `index.html`
