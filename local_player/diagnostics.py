from __future__ import annotations

import json
import logging
import os
import platform
import sys
import tempfile
import threading
import time
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

LOG_NAMES = ("server", "http", "media", "browser")


def default_log_root() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir())
    return base / "ShortVideosLocalPlayer" / "logs"


def _json_default(value: Any) -> str:
    if isinstance(value, Path):
        return str(value)
    return repr(value)


class Diagnostics:
    """Small structured logger used by both the HTTP server and media pipeline."""

    def __init__(self, log_dir: Path | None = None, debug: bool = False):
        self.log_dir = (log_dir or default_log_root()).expanduser().resolve()
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.debug = debug
        self._lock = threading.RLock()
        self._loggers: dict[str, logging.Logger] = {}
        for name in LOG_NAMES:
            logger = logging.getLogger(f"local_short_videos.{name}.{id(self)}")
            logger.setLevel(logging.DEBUG)
            logger.propagate = False
            handler = RotatingFileHandler(
                self.log_dir / f"{name}.log",
                maxBytes=8 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
            self._loggers[name] = logger

    def path(self, name: str) -> Path:
        return self.log_dir / f"{name}.log"

    def event(self, channel: str, event: str, **fields: Any) -> None:
        logger = self._loggers.get(channel) or self._loggers["server"]
        payload = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "timeUnix": round(time.time(), 3),
            "event": event,
            **fields,
        }
        line = json.dumps(payload, ensure_ascii=False, default=_json_default, separators=(",", ":"))
        with self._lock:
            logger.info(line)
        if self.debug and channel in ("server", "media"):
            print(f"[{channel}] {event}: {json.dumps(fields, ensure_ascii=False, default=_json_default)}")

    def exception(self, channel: str, event: str, exc: BaseException, **fields: Any) -> None:
        self.event(
            channel,
            event,
            errorType=type(exc).__name__,
            error=str(exc),
            traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            **fields,
        )

    def startup_snapshot(self, **fields: Any) -> dict[str, Any]:
        snapshot = {
            "version": 1,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "python": sys.version,
            "pythonExecutable": sys.executable,
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cwd": str(Path.cwd()),
            "argv": sys.argv,
            "logDir": str(self.log_dir),
            **fields,
        }
        path = self.log_dir / "startup.json"
        path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
        self.event("server", "startup_snapshot", snapshotPath=str(path), **fields)
        return snapshot

    def append_browser_events(self, payload: Any, remote: str, user_agent: str) -> int:
        events = payload if isinstance(payload, list) else [payload]
        accepted = 0
        for item in events[:100]:
            if not isinstance(item, dict):
                continue
            self.event(
                "browser",
                str(item.get("event") or "client_event"),
                remote=remote,
                userAgent=user_agent,
                client=item,
            )
            accepted += 1
        return accepted

    def tail(self, name: str, max_bytes: int = 128 * 1024) -> str:
        if name not in LOG_NAMES:
            raise ValueError("不支持的日志名称")
        path = self.path(name)
        if not path.is_file():
            return ""
        with path.open("rb") as source:
            size = path.stat().st_size
            source.seek(max(0, size - max_bytes))
            data = source.read(max_bytes)
        return data.decode("utf-8", errors="replace")
