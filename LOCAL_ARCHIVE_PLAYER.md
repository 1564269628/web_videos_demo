# 本地短视频播放器

这是一个只读取本地归档目录的播放器，不请求原视频 API，也不会修改归档目录。

## 运行

默认归档目录：

```text
F:\tools\short_videos
```

代码可以放在任意目录，直接运行：

```powershell
python local_archive_player.py
```

程序默认：

- 同时监听全部 IPv4 和 IPv6 地址；
- 最多扫描 50 个已下载视频，达到上限后立即停止；
- 不自动打开浏览器；
- 电脑手动访问 `http://127.0.0.1:8765/`；
- 手机使用终端显示的局域网地址访问。

归档目录改变时：

```powershell
python local_archive_player.py --root "D:\其他目录\short_videos"
```

扫描全部视频：

```powershell
python local_archive_player.py --scan-limit 0
```

测试其他数量：

```powershell
python local_archive_player.py --scan-limit 200
```

确实需要启动后自动打开电脑浏览器时：

```powershell
python local_archive_player.py --open
```

## 播放和作者主页

- 当前视频进入画面后自动播放，离开后自动暂停。
- 手机端视频底部显示进度条、当前时间和总时长，可直接拖动跳转。
- 点击作者头像或作者名称打开作者主页。
- 作者主页只展示本次扫描范围内、且真正存在本地视频文件的作品。
- 作者作品网格支持滚动；点击封面回到信息流并播放该作品。
- 默认扫描上限为 50，因此作者主页显示的是这 50 个视频中的作者作品子集。

## FFmpeg

大量归档文件是 `video.ts`。Chrome、Edge 和手机浏览器通常不能直接播放裸 TS，因此应确保：

```powershell
ffmpeg -version
ffprobe -version
```

`video.ts` 和 `video.mkv` 首次播放时，程序使用 FFmpeg `-c copy` 无损封装为缓存 MP4，不重新编码，也不改变画质。

也可以显式指定：

```powershell
python local_archive_player.py --ffmpeg "C:\ffmpeg\bin\ffmpeg.exe"
```

## 手机访问

程序默认绑定 `[::]:8765`，在支持双栈的 Windows 系统上同时接受 IPv6 和 IPv4。手机与电脑连接同一个局域网后，使用终端打印的地址，例如：

```text
http://192.168.1.23:8765/
```

Windows 防火墙弹窗只允许“专用网络”。不要把 8765 端口映射到公网，因为服务没有登录验证。

## 诊断日志

默认日志目录：

```text
%LOCALAPPDATA%\ShortVideosLocalPlayer\logs
```

包含：

- `startup.json`：启动参数、扫描上限、网络地址、FFmpeg 和缓存目录；
- `server.log`：扫描开始、完成、耗时和扫描结果；
- `http.log`：Range 请求、MIME、传输字节和客户端断开；
- `media.log`：FFmpeg、FFprobe、缓存和编解码器信息；
- `browser.log`：浏览器播放、缓冲、拖动进度和错误事件。

详细模式：

```powershell
python local_archive_player.py --debug
```

## 参数

```text
--root          归档根目录
--host          监听地址，默认 ::
--port          监听端口，默认 8765
--scan-limit    最多扫描的视频数量，默认 50；0 表示不限
--ffmpeg        FFmpeg 可执行文件路径
--log-dir       诊断日志目录
--debug         在终端同步输出详细日志
--open          启动后自动打开电脑浏览器，默认关闭
```
