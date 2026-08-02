# 全部作者下载中心

预览分支新增 `archive-global-downloader.js` 与 `archive-global-downloader.css`。

使用流程：

1. 打开 `/previews/archive-center-v2/`。
2. 点击页面顶部“下载全部作者”。
3. 首次选择归档总目录，例如 `F:\tools\short_videos`。
4. 程序扫描目录下所有包含 `author.json` 与 `works.json` 的作者文件夹。
5. 先按视频 ID，再按规范化标题和时长进行全局去重。
6. 点击“扫描结果全部加入队列”和“开始下载全部”。

默认设置：同时下载 4 个视频，每个视频 6 个分片并发。大视频默认不会跳过；勾选“暂时跳过超过阈值的视频”后才启用分片阈值。

已下载视频会分别写回各作者自己的 `works/` 目录，并更新对应 `archive-index.json`。跨作者重复作品写入 `duplicate.json`，不重复占用磁盘。
