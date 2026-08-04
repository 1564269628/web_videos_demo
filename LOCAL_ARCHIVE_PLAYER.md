# 本地短视频播放器

这是一个只读取本地归档目录的播放器。它不会请求原视频 API，也不会修改归档目录。

## 运行

默认归档目录已经设置为：

```text
F:\tools\short_videos
```

代码目录可以放在任意位置。保留下面这些文件的相对位置，然后直接运行：

```powershell
python local_archive_player.py
```

程序会扫描本地归档，启动 `http://127.0.0.1:8765/`，并自动打开浏览器。

归档目录改变时：

```powershell
python local_archive_player.py --root "D:\其他目录\short_videos"
```

停止服务：在命令行窗口按 `Ctrl+C`。

## 默认行为

- 只显示存在 `video.ts`、`video.mp4`、`video.webm`、`video.mkv` 或 `video.mov` 的已下载作品。
- 随机混合所有作者的本地视频。
- 纵向滚动、方向键和 PageUp/PageDown 切换视频。
- 显示标题、作者、播放量、点赞量、评论量和收藏量。
- 点击作者进入本地作者主页，查看该作者全部已下载作品。
- 读取 `author.json`、`works.json`、`metadata.json` 以及作品目录。
- 识别 `cover.jpg/webp/png/avif/bin`，不依赖文件扩展名判断图片格式。
- 支持 HTTP Range，MP4 可以拖动进度。
- 不删除、不移动、不修改 `F:\tools\short_videos` 中的文件。

## FFmpeg

大部分归档视频是 `video.ts`。Chrome 和 Edge 通常不能直接播放裸 TS，因此需要安装 FFmpeg，并确保命令行中可以运行：

```powershell
ffmpeg -version
ffprobe -version
```

`video.ts` 和 `video.mkv` 首次播放时，程序通过 FFmpeg 的 `-c copy` 无损封装为缓存 MP4，不重新编码，也不改变画质。

也可以显式指定 FFmpeg：

```powershell
python local_archive_player.py --ffmpeg "C:\ffmpeg\bin\ffmpeg.exe"
```

转换缓存保存在当前 Windows 用户的本地应用数据目录中，不会写入归档目录。

## 诊断日志

程序默认把日志写入：

```text
%LOCALAPPDATA%\ShortVideosLocalPlayer\logs
```

启动时终端也会显示日志目录。目录中包含：

- `startup.json`：Python、Windows、FFmpeg、FFprobe、缓存目录和启动参数。
- `server.log`：启动、目录扫描和服务状态。
- `http.log`：每个请求的 Range、MIME、计划传输字节、实际传输字节和客户端断开原因。
- `media.log`：FFmpeg 命令、完整 stderr、ffprobe 编解码器信息、缓存路径和转换结果。
- `browser.log`：浏览器 video 元素的 `loadedmetadata`、`playing`、`waiting`、`stalled`、`error` 以及 `MediaError` 代码。

日志使用 JSON Lines 格式，单个文件达到 8 MB 后自动轮转，最多保留 5 个旧文件。

需要在终端同步显示媒体诊断时：

```powershell
python local_archive_player.py --debug
```

也可以指定日志目录：

```powershell
python local_archive_player.py --log-dir "D:\short-video-player-logs"
```

出现黑屏时，先保持页面停留几秒，让浏览器把事件写入日志，然后复制整个日志目录。最关键的是 `browser.log` 和 `media.log`。页面上的“诊断编号”对应作品 ID，可在浏览器打开下面的本地接口查看该视频的源文件、缓存文件和 ffprobe 结果：

```text
http://127.0.0.1:8765/api/diagnostics?id=诊断编号
```

Windows 的 `10053`、`10054` 通常表示浏览器取消了当前 Range 请求。新版本会把它记录为 `client_disconnected`，不会再尝试发送第二个 500 响应。

## 参数

```text
--root      归档根目录
--host      监听地址，默认 127.0.0.1
--port      监听端口，默认 8765
--ffmpeg    FFmpeg 可执行文件路径
--log-dir   诊断日志目录
--debug     在终端同步输出详细媒体日志
--no-open   启动后不自动打开浏览器
```
