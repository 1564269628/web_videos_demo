# 作者完整归档

网页在作者主页中提供“导出作者全部数据”按钮。此功能使用浏览器 File System Access API，必须由用户主动选择并授权一个本地文件夹。

## 使用方法

1. 使用最新版 Microsoft Edge 或 Chrome 打开网页。
2. 进入任意作者主页。
3. 点击“导出作者全部数据”。
4. 选择本地保存文件夹。
5. 设置每个视频的 HLS 分片并发数（1～16，建议 6）。
6. 保持网页打开，等待右下角进度面板完成。

## 保存结构

```text
作者昵称_UID/
├─ author.json
├─ author.raw.json
├─ works.json
├─ works.raw.json
├─ works.csv
├─ export-state.json
├─ assets/
│  ├─ avatar.webp
│  └─ background.webp
└─ works/
   └─ 00001_标题_视频ID/
      ├─ metadata.json
      ├─ metadata.raw.json
      ├─ cover.webp
      ├─ playlist.m3u8
      ├─ video.ts 或 video.mp4
      └─ download.json
```

## 断点续传

每完成一个作品就会更新 `export-state.json`。导出中断后，重新进入同一作者主页、再次点击导出并选择原来的父文件夹，程序会跳过已经完成的视频。

## 说明

- 视频按 HLS 原始容器流式写入磁盘，不会把作者的全部视频同时放入内存。
- 普通 MPEG-TS 分片保存为 `video.ts`；带初始化分片的流保存为 `video.mp4`。
- 单个作品失败不会终止整个作者归档；失败原因会记录在 `export-state.json` 和页面日志中。
- “全部作品”指作者作品接口能够分页返回的全部可访问作品；已经删除、无权限或服务器不再提供播放地址的作品无法下载。
- 仅归档你有权保存的内容。
