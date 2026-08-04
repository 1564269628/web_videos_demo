# 本地短视频播放器

这是一个只读取本地归档目录的播放器。它不会请求原视频 API，也不会修改归档目录。

## 运行

默认归档目录：

```text
F:\tools\short_videos
```

代码目录可以放在任意位置，保留项目内文件相对位置后直接运行：

```powershell
python local_archive_player.py
```

程序会自动打开本机页面：

```text
http://127.0.0.1:8765/
```

归档目录改变时：

```powershell
python local_archive_player.py --root "D:\其他目录\short_videos"
```

停止服务：在命令行窗口按 `Ctrl+C`。

## 手机访问与监听地址

默认监听：

```text
[::]:8765
```

程序会创建 IPv6 双栈监听器。在 Windows 和大多数现代系统上，同一个端口会同时接受：

- 所有 IPv4 地址，例如 `0.0.0.0:8765`
- 所有 IPv6 地址，例如 `[::]:8765`

启动终端会自动打印可供手机访问的局域网地址，例如：

```text
http://192.168.1.23:8765/
http://[240e:xxxx:xxxx::1234]:8765/
```

手机和电脑需要连接同一个路由器或局域网。第一次启动时，Windows 防火墙可能弹窗，请只允许“专用网络”。

如果当前系统不能建立 IPv6 双栈监听，可以仅监听全部 IPv4：

```powershell
python local_archive_player.py --host 0.0.0.0
```

服务没有账号和密码，只适合可信的家庭或办公局域网。不要在路由器中把端口 `8765` 映射到公网。

诊断日志查看接口仍然只允许本机访问；手机只能访问视频库、封面、作者信息和视频流。

## 默认行为

- 只显示存在 `video.ts`、`video.mp4`、`video.webm`、`video.mkv` 或 `video.mov` 的已下载作品。
- 随机混合所有作者的本地视频。
- 纵向滚动、方向键和 PageUp/PageDown 切换视频。
- 显示标题、作者、播放量、点赞量、评论量和收藏量。
- 点击作者进入本地作者主页，查看该作者全部已下载作品。
- 读取 `author.json`、`works.json`、`metadata.json` 以及作品目录。
- 识别 `cover.jpg/webp/png/avif/bin`，不依赖文件扩展名判断图片格式。
- 支持 HTTP Range，MP4 可以拖动进度。
- 不删除、不移动、不修改归档目录中的文件。

## FFmpeg

大部分归档视频是 `video.ts`。Chrome 和 Edge 通常不能直接播放裸 TS，因此需要 FFmpeg，并确保命令行中可以运行：

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

目录中包含：

- `startup.json`：Python、Windows、监听模式、局域网 URL、FFmpeg、FFprobe、缓存目录和启动参数。
- `server.log`：启动、目录扫描和服务状态。
- `http.log`：请求来源、Range、MIME、计划传输字节、实际传输字节和客户端断开原因。
- `media.log`：FFmpeg 命令、完整 stderr、ffprobe 编解码器信息、缓存路径和转换结果。
- `browser.log`：浏览器 video 元素的加载、缓冲、播放、暂停和 MediaError。

需要在终端同步显示媒体诊断时：

```powershell
python local_archive_player.py --debug
```

也可以指定日志目录：

```powershell
python local_archive_player.py --log-dir "D:\short-video-player-logs"
```

本机诊断接口：

```text
http://127.0.0.1:8765/api/diagnostics?id=作品ID
```

## 参数

```text
--root      归档根目录
--host      监听地址，默认 ::，同时接受 IPv6 和 IPv4
--port      监听端口，默认 8765
--ffmpeg    FFmpeg 可执行文件路径
--log-dir   诊断日志目录
--debug     在终端同步输出详细媒体日志
--no-open   启动后不自动打开浏览器
```
