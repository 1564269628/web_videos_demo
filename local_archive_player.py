#!/usr/bin/env python3
"""本地短视频媒体库入口。代码目录可以放在任意位置。"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
import threading
import time
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from local_player.catalog import APP_VERSION, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_ROOT, safe_int, sniff_image_type
from local_player.library import Library
from local_player.media import find_ffmpeg

WEB_DIR = Path(__file__).resolve().with_name("local_player_web")
PLACEHOLDER_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="100%" height="100%" fill="#151515"/><circle cx="360" cy="430" r="90" fill="#ffffff18"/><path d="M330 370l105 60-105 60z" fill="#fff"/><text x="360" y="590" text-anchor="middle" fill="#aaa" font-size="30" font-family="sans-serif">本地视频</text></svg>""".encode("utf-8")


def parse_range(value: str, size: int) -> tuple[int, int] | None:
    match = re.match(r"bytes=(\d*)-(\d*)", value or "")
    if not match:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if not start_text:
        length = int(end_text)
        return max(0, size - length), size - 1
    start = int(start_text)
    end = int(end_text) if end_text else size - 1
    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


class Handler(BaseHTTPRequestHandler):
    server_version = f"LocalShortVideos/{APP_VERSION}"
    library: Library

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/":
                self.send_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
            elif path == "/assets/style.css":
                self.send_file(WEB_DIR / "style.css", "text/css; charset=utf-8")
            elif path == "/assets/app.js":
                self.send_file(WEB_DIR / "app.js", "text/javascript; charset=utf-8")
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
            elif path.startswith("/media/"):
                work_id = path.rsplit("/", 1)[-1]
                source_kind = (query.get("source") or ["original"])[0]
                file_path = self.library.playable_path(work_id, source_kind)
                if not file_path:
                    self.send_error(HTTPStatus.NOT_FOUND, "视频文件不存在")
                else:
                    self.send_file(file_path)
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
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/rescan":
            try:
                self.send_json(self.library.scan())
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

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
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path, content_type: str | None = None) -> None:
        path = path.resolve()
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        size = path.stat().st_size
        mime = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        range_value = self.headers.get("Range", "")
        byte_range = parse_range(range_value, size) if range_value else None
        if range_value and byte_range is None:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        start, end = byte_range or (0, size - 1)
        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT if byte_range else HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        if byte_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining > 0:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地抖音式短视频媒体库")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=f"归档根目录，默认 {DEFAULT_ROOT}")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机 127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--ffmpeg", help="FFmpeg 可执行文件路径；默认从 PATH 查找")
    parser.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    library = Library(args.root.expanduser(), find_ffmpeg(args.ffmpeg))
    try:
        summary = library.scan()
    except Exception as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2
    Handler.library = library
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    url = f"http://{args.host}:{args.port}/"
    print("=" * 66)
    print("本地短视频库已启动")
    print(f"归档目录：{summary['root']}")
    print(f"作者数量：{summary['authorCount']}，本地视频：{summary['videoCount']}")
    print(f"FFmpeg：{'已检测到 ' + library.ffmpeg if library.ffmpeg else '未检测到（TS 播放建议安装）'}")
    print(f"访问地址：{url}")
    print("按 Ctrl+C 停止。程序不会修改归档目录。")
    print("=" * 66)
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n正在停止…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
