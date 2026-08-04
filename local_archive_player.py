#!/usr/bin/env python3
"""本地短视频媒体库入口。代码目录可以放在任意位置。"""
from __future__ import annotations

import argparse
import ipaddress
import json
import mimetypes
import re
import socket
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from local_player.catalog import APP_VERSION, DEFAULT_PORT, DEFAULT_ROOT, safe_int, sniff_image_type
from local_player.diagnostics import Diagnostics, default_log_root
from local_player.library import Library
from local_player.media import find_ffmpeg, media_mime

WEB_DIR = Path(__file__).resolve().with_name("local_player_web")
PLACEHOLDER_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="100%" height="100%" fill="#151515"/><circle cx="360" cy="430" r="90" fill="#ffffff18"/><path d="M330 370l105 60-105 60z" fill="#fff"/><text x="360" y="590" text-anchor="middle" fill="#aaa" font-size="30" font-family="sans-serif">本地视频</text></svg>""".encode("utf-8")
DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
DEFAULT_LISTEN_HOST = "::"


def parse_range(value: str, size: int) -> tuple[int, int] | None:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", (value or "").strip())
    if not match:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if not start_text:
        length = int(end_text)
        if length <= 0:
            return None
        return max(0, size - length), size - 1
    start = int(start_text)
    end = int(end_text) if end_text else size - 1
    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


def content_type_for(path: Path, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    if path.suffix.lower() in (".mp4", ".m4v", ".mov", ".webm", ".ts", ".mkv"):
        return media_mime(path)
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def normalized_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Parse normal and IPv4-mapped IPv6 addresses, ignoring a zone suffix."""
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def format_url(host: str, port: int) -> str:
    host = host.split("%", 1)[0]
    return f"http://[{host}]:{port}/" if ":" in host else f"http://{host}:{port}/"


def browser_url(host: str, port: int) -> str:
    if host in ("", "0.0.0.0", "::"):
        return f"http://127.0.0.1:{port}/"
    return format_url(host, port)


def discover_access_urls(port: int) -> list[str]:
    """Best-effort list of LAN addresses for display; listening does not depend on it."""
    addresses: set[str] = set()

    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(
            socket.gethostname(), port, socket.AF_UNSPEC, socket.SOCK_STREAM
        ):
            if family in (socket.AF_INET, socket.AF_INET6):
                addresses.add(sockaddr[0])
    except OSError:
        pass

    for family, target in (
        (socket.AF_INET, ("192.0.2.1", 9)),
        (socket.AF_INET6, ("2001:db8::1", 9, 0, 0)),
    ):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as probe:
                probe.connect(target)
                addresses.add(probe.getsockname()[0])
        except OSError:
            pass

    def sort_key(value: str) -> tuple[int, str]:
        address = normalized_ip(value)
        return (0 if isinstance(address, ipaddress.IPv4Address) else 1, value)

    urls: list[str] = []
    for raw in sorted(addresses, key=sort_key):
        address = normalized_ip(raw)
        if not address or address.is_loopback or address.is_unspecified or address.is_link_local:
            continue
        urls.append(format_url(raw, port))
    return list(dict.fromkeys(urls))


class DualStackThreadingHTTPServer(ThreadingHTTPServer):
    """IPv6 wildcard listener that also accepts IPv4-mapped connections."""

    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self) -> None:
        self.dual_stack_enabled = False
        if self.server_address[0] in ("", "::") and hasattr(socket, "IPV6_V6ONLY"):
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                self.dual_stack_enabled = self.socket.getsockopt(
                    socket.IPPROTO_IPV6, socket.IPV6_V6ONLY
                ) == 0
            except OSError:
                self.dual_stack_enabled = False
        super().server_bind()


class IPv4ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET
    allow_reuse_address = True


def make_server(host: str, port: int, handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    address = normalized_ip(host)
    server_class: type[ThreadingHTTPServer]
    if isinstance(address, ipaddress.IPv6Address) or host == "::":
        server_class = DualStackThreadingHTTPServer
    else:
        server_class = IPv4ThreadingHTTPServer
    server = server_class((host, port), handler)
    server.daemon_threads = True
    return server


class Handler(BaseHTTPRequestHandler):
    server_version = f"LocalShortVideos/{APP_VERSION}"
    protocol_version = "HTTP/1.1"
    library: Library
    diagnostics: Diagnostics

    def handle(self) -> None:
        try:
            super().handle()
        except DISCONNECT_ERRORS as exc:
            try:
                self.diagnostics.event(
                    "http",
                    "client_disconnected_between_requests",
                    remote=self._remote(),
                    errorType=type(exc).__name__,
                    error=str(exc),
                )
            except Exception:
                pass

    def _begin(self) -> None:
        self.request_id = uuid.uuid4().hex[:12]
        self.request_started = time.time()
        self.response_started = False
        self.response_status: int | None = None

    def _remote(self) -> str:
        return f"{self.client_address[0]}:{self.client_address[1]}"

    def _remote_is_loopback(self) -> bool:
        address = normalized_ip(self.client_address[0])
        return bool(address and address.is_loopback)

    def _require_loopback(self) -> bool:
        if self._remote_is_loopback():
            return True
        self.send_json({"error": "该诊断接口仅允许在运行程序的电脑上访问"}, HTTPStatus.FORBIDDEN)
        return False

    def log_message(self, fmt: str, *args: Any) -> None:
        self.diagnostics.event(
            "http",
            "access_log",
            requestId=getattr(self, "request_id", "unknown"),
            remote=self._remote(),
            method=getattr(self, "command", ""),
            path=getattr(self, "path", ""),
            message=fmt % args,
        )

    def send_response(self, code: int, message: str | None = None) -> None:
        self.response_started = True
        self.response_status = code
        super().send_response(code, message)

    def do_GET(self) -> None:
        self._begin()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        self.diagnostics.event(
            "http",
            "request_started",
            requestId=self.request_id,
            remote=self._remote(),
            method="GET",
            path=path,
            query=parsed.query,
            range=self.headers.get("Range"),
            userAgent=self.headers.get("User-Agent"),
            referer=self.headers.get("Referer"),
        )
        try:
            if path == "/":
                self.send_file(WEB_DIR / "index.html", "text/html; charset=utf-8", cache_control="no-store")
            elif path == "/assets/style.css":
                self.send_file(WEB_DIR / "style.css", "text/css; charset=utf-8", cache_control="no-store")
            elif path == "/assets/app.js":
                self.send_file(WEB_DIR / "app.js", "text/javascript; charset=utf-8", cache_control="no-store")
            elif path == "/api/summary":
                self.send_json(self.library.summary())
            elif path == "/api/feed":
                seed = (query.get("seed") or [str(int(time.time()))])[0]
                offset = safe_int((query.get("offset") or [0])[0])
                limit = safe_int((query.get("limit") or [18])[0], 18)
                self.send_json(self.library.feed(seed, offset, limit))
            elif path == "/api/author":
                author_id = (query.get("id") or [""])[0]
                payload = self.library.author_payload(
                    author_id,
                    safe_int((query.get("offset") or [0])[0]),
                    safe_int((query.get("limit") or [80])[0], 80),
                )
                if payload is None:
                    self.send_json({"error": "作者不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json(payload)
            elif path == "/api/video":
                work_id = (query.get("id") or [""])[0]
                payload = self.library.public_work(work_id)
                if payload is None:
                    self.send_json({"error": "视频不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json(payload)
            elif path == "/api/play":
                work_id = (query.get("id") or [""])[0]
                payload = self.library.play_status(work_id)
                if payload is None:
                    self.send_json({"error": "视频不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json(payload)
            elif path == "/api/diagnostics":
                if not self._require_loopback():
                    return
                work_id = (query.get("id") or [""])[0]
                payload = self.library.diagnostics_payload(work_id)
                if payload is None:
                    self.send_json({"error": "视频不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json(payload)
            elif path == "/api/logs":
                if not self._require_loopback():
                    return
                self.send_json(
                    {
                        "logDir": str(self.diagnostics.log_dir),
                        "files": {
                            name: str(self.diagnostics.path(name))
                            for name in ("server", "http", "media", "browser")
                        },
                    }
                )
            elif path == "/api/log-tail":
                if not self._require_loopback():
                    return
                name = (query.get("name") or ["browser"])[0]
                try:
                    text = self.diagnostics.tail(name)
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                else:
                    self.send_bytes(
                        text.encode("utf-8"),
                        "text/plain; charset=utf-8",
                        extra_headers={"Cache-Control": "no-store"},
                    )
            elif path.startswith("/media/"):
                work_id = path.rsplit("/", 1)[-1]
                source_kind = (query.get("source") or ["original"])[0]
                file_path = self.library.playable_path(work_id, source_kind)
                if not file_path:
                    self.send_error(HTTPStatus.NOT_FOUND, "视频文件不存在")
                else:
                    self.send_file(
                        file_path,
                        media_mime(file_path),
                        media_context={"workId": work_id, "source": source_kind},
                    )
            elif path.startswith("/cover/"):
                work_id = path.rsplit("/", 1)[-1]
                image_path, image_type = self.library.cover_path(work_id)
                if image_path:
                    self.send_file(image_path, image_type)
                else:
                    self.send_bytes(PLACEHOLDER_SVG, "image/svg+xml")
            elif path.startswith("/avatar/"):
                author_id = path.rsplit("/", 1)[-1]
                author = self.library.authors.get(author_id)
                if author and author.avatar and sniff_image_type(author.avatar):
                    self.send_file(author.avatar, sniff_image_type(author.avatar))
                else:
                    self.send_bytes(PLACEHOLDER_SVG, "image/svg+xml")
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except DISCONNECT_ERRORS as exc:
            self._log_disconnect(exc, phase="route")
        except Exception as exc:
            self.diagnostics.exception(
                "http",
                "request_failed",
                exc,
                requestId=self.request_id,
                remote=self._remote(),
                method="GET",
                path=path,
                responseStarted=self.response_started,
                responseStatus=self.response_status,
            )
            self.close_connection = True
            if not self.response_started:
                try:
                    self.send_json({"error": str(exc), "requestId": self.request_id}, HTTPStatus.INTERNAL_SERVER_ERROR)
                except DISCONNECT_ERRORS as disconnect:
                    self._log_disconnect(disconnect, phase="error_response")

    def do_POST(self) -> None:
        self._begin()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        self.diagnostics.event(
            "http",
            "request_started",
            requestId=self.request_id,
            remote=self._remote(),
            method="POST",
            path=path,
            contentType=self.headers.get("Content-Type"),
            contentLength=self.headers.get("Content-Length"),
            userAgent=self.headers.get("User-Agent"),
        )
        try:
            if path == "/api/rescan":
                self._discard_body()
                self.send_json(self.library.scan())
            elif path == "/api/client-log":
                payload = self._read_json_body(max_bytes=256 * 1024)
                accepted = self.diagnostics.append_browser_events(
                    payload,
                    remote=self._remote(),
                    user_agent=self.headers.get("User-Agent", ""),
                )
                self.send_json({"ok": True, "accepted": accepted})
            else:
                self._discard_body()
                self.send_error(HTTPStatus.NOT_FOUND)
        except DISCONNECT_ERRORS as exc:
            self._log_disconnect(exc, phase="post")
        except Exception as exc:
            self.diagnostics.exception(
                "http",
                "post_failed",
                exc,
                requestId=self.request_id,
                remote=self._remote(),
                path=path,
                responseStarted=self.response_started,
            )
            self.close_connection = True
            if not self.response_started:
                try:
                    self.send_json({"error": str(exc), "requestId": self.request_id}, HTTPStatus.INTERNAL_SERVER_ERROR)
                except DISCONNECT_ERRORS:
                    pass

    def _read_json_body(self, max_bytes: int) -> Any:
        length = safe_int(self.headers.get("Content-Length"), 0)
        if length < 0 or length > max_bytes:
            raise ValueError(f"请求体过大：{length} bytes")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8", errors="replace"))

    def _discard_body(self) -> None:
        length = safe_int(self.headers.get("Content-Length"), 0)
        if length > 0:
            self.rfile.read(min(length, 256 * 1024))

    def send_json(self, value: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
            {"Cache-Control": "no-store"},
        )

    def send_bytes(
        self,
        data: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "keep-alive")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except DISCONNECT_ERRORS as exc:
            self._log_disconnect(exc, phase="send_bytes", plannedBytes=len(data), sentBytes=0)
            return
        self.diagnostics.event(
            "http",
            "response_completed",
            requestId=self.request_id,
            status=int(status),
            contentType=content_type,
            bytesSent=len(data),
            elapsedMs=round((time.time() - self.request_started) * 1000, 2),
        )

    def send_file(
        self,
        path: Path,
        content_type: str | None = None,
        cache_control: str = "private, max-age=3600",
        media_context: dict[str, Any] | None = None,
    ) -> None:
        path = path.resolve()
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        size = path.stat().st_size
        mime = content_type_for(path, content_type)
        range_value = self.headers.get("Range", "")
        byte_range = parse_range(range_value, size) if range_value else None
        if range_value and byte_range is None:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.diagnostics.event(
                "http",
                "range_rejected",
                requestId=self.request_id,
                path=str(path),
                fileBytes=size,
                range=range_value,
                **(media_context or {}),
            )
            return
        start, end = byte_range or (0, size - 1)
        length = end - start + 1
        status = HTTPStatus.PARTIAL_CONTENT if byte_range else HTTPStatus.OK
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "keep-alive")
        if byte_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        sent = 0
        self.diagnostics.event(
            "http",
            "file_send_started",
            requestId=self.request_id,
            path=str(path),
            status=int(status),
            contentType=mime,
            fileBytes=size,
            range=range_value or None,
            rangeStart=start,
            rangeEnd=end,
            plannedBytes=length,
            **(media_context or {}),
        )
        try:
            with path.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    sent += len(chunk)
                    remaining -= len(chunk)
        except DISCONNECT_ERRORS as exc:
            self._log_disconnect(
                exc,
                phase="send_file",
                filePath=str(path),
                plannedBytes=length,
                sentBytes=sent,
                range=range_value or None,
                **(media_context or {}),
            )
            return
        self.diagnostics.event(
            "http",
            "file_send_completed",
            requestId=self.request_id,
            path=str(path),
            status=int(status),
            contentType=mime,
            fileBytes=size,
            plannedBytes=length,
            sentBytes=sent,
            range=range_value or None,
            elapsedMs=round((time.time() - self.request_started) * 1000, 2),
            **(media_context or {}),
        )

    def _log_disconnect(self, exc: BaseException, phase: str, **fields: Any) -> None:
        self.close_connection = True
        self.diagnostics.event(
            "http",
            "client_disconnected",
            requestId=getattr(self, "request_id", "unknown"),
            remote=self._remote(),
            method=getattr(self, "command", ""),
            requestPath=getattr(self, "path", ""),
            phase=phase,
            errorType=type(exc).__name__,
            error=str(exc),
            responseStarted=getattr(self, "response_started", False),
            responseStatus=getattr(self, "response_status", None),
            elapsedMs=round((time.time() - getattr(self, "request_started", time.time())) * 1000, 2),
            **fields,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地抖音式短视频媒体库")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=f"归档根目录，默认 {DEFAULT_ROOT}")
    parser.add_argument(
        "--host",
        default=DEFAULT_LISTEN_HOST,
        help="监听地址；默认 ::，在支持双栈的系统上同时监听所有 IPv6 和 IPv4 地址",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--ffmpeg", help="FFmpeg 可执行文件路径；默认从 PATH 查找")
    parser.add_argument("--log-dir", type=Path, default=default_log_root(), help="诊断日志目录")
    parser.add_argument("--debug", action="store_true", help="在终端同时输出详细媒体日志")
    parser.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    diagnostics = Diagnostics(args.log_dir, debug=args.debug)
    ffmpeg = find_ffmpeg(args.ffmpeg)
    library = Library(args.root.expanduser(), ffmpeg, diagnostics)
    try:
        summary = library.scan()
    except Exception as exc:
        diagnostics.exception("server", "startup_failed", exc)
        print(f"[错误] {exc}", file=sys.stderr)
        print(f"诊断日志：{diagnostics.log_dir}", file=sys.stderr)
        return 2

    Handler.library = library
    Handler.diagnostics = diagnostics
    try:
        server = make_server(args.host, args.port, Handler)
    except OSError as exc:
        diagnostics.exception("server", "listen_failed", exc, host=args.host, port=args.port)
        print(f"[错误] 无法监听 {args.host}:{args.port}：{exc}", file=sys.stderr)
        print("可尝试 --host 0.0.0.0 仅监听全部 IPv4 地址。", file=sys.stderr)
        return 3

    dual_stack = bool(getattr(server, "dual_stack_enabled", False))
    local_url = browser_url(args.host, args.port)
    lan_urls = discover_access_urls(args.port)
    diagnostics.startup_snapshot(
        appVersion=APP_VERSION,
        archiveRoot=str(args.root.expanduser().resolve()),
        host=args.host,
        port=args.port,
        addressFamily="IPv6" if server.address_family == socket.AF_INET6 else "IPv4",
        dualStack=dual_stack,
        localUrl=local_url,
        lanUrls=lan_urls,
        ffmpeg=ffmpeg,
        ffprobe=library.media.ffprobe,
        cacheDir=str(library.media.cache),
    )
    diagnostics.event(
        "server",
        "server_listening",
        bindHost=args.host,
        port=args.port,
        addressFamily="IPv6" if server.address_family == socket.AF_INET6 else "IPv4",
        dualStack=dual_stack,
        localUrl=local_url,
        lanUrls=lan_urls,
        summary=summary,
    )

    print("=" * 72)
    print("本地短视频库已启动")
    print(f"归档目录：{summary['root']}")
    print(f"作者数量：{summary['authorCount']}，本地视频：{summary['videoCount']}")
    print(f"FFmpeg：{'已检测到 ' + library.ffmpeg if library.ffmpeg else '未检测到'}")
    print(f"FFprobe：{'已检测到 ' + library.media.ffprobe if library.media.ffprobe else '未检测到'}")
    print(f"监听地址：{args.host}:{args.port}")
    if server.address_family == socket.AF_INET6:
        print(f"网络模式：IPv6{' + IPv4 双栈' if dual_stack else '（当前系统未启用 IPv4 双栈）'}")
    else:
        print("网络模式：IPv4")
    print(f"本机访问：{local_url}")
    if lan_urls:
        print("手机访问（手机与电脑连接同一局域网）：")
        for url in lan_urls:
            print(f"  {url}")
    else:
        print("未自动识别局域网 IP，请在 Windows 中运行 ipconfig 后使用 WLAN/以太网地址。")
    print(f"缓存目录：{library.media.cache}")
    print(f"日志目录：{diagnostics.log_dir}")
    print("注意：服务没有登录验证，只应在可信的家庭/办公局域网中使用，不要映射公网端口。")
    print("Windows 防火墙弹窗请选择仅允许“专用网络”。")
    print("按 Ctrl+C 停止。程序不会修改归档目录。")
    print("=" * 72)

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(local_url)).start()
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n正在停止…")
        diagnostics.event("server", "keyboard_interrupt")
    finally:
        server.server_close()
        diagnostics.event("server", "server_stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
