# 全部作者归档预览

分支：`feature/archive-center-v2-preview`

预览地址：`/previews/archive-center-v2/`

本预览只保留一条归档流程：

1. 选择归档总目录，例如 `F:\tools\short_videos`
2. 扫描总目录下一层的全部作者文件夹
3. 从每个作者目录读取 `author.json`、`works.json`、`works/` 和 `archive-index.json`
4. 汇总全部作者作品，按视频 ID 或“规范化标题 + 时长”跨作者去重
5. 统一加入多视频并发下载队列，单视频内部并发下载 HLS 分片
6. 已下载的 MP4/TS、封面、标题、标签和作者信息可在归档中心内浏览与播放

预览页不再加载单作者归档中心、单作者目录恢复、DOM 观察器补丁、gzip 自解压下载器或恢复脚本。

主要文件：

- `archive-all-authors.js`
- `archive-all-authors.css`
- `index.html`
