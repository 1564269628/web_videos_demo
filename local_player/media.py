from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from .catalog import Catalog, Work, sniff_image_type


def cache_root() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "ShortVideosLocalPlayer" / "cache"


def find_ffmpeg(explicit: str | None) -> str | None:
    if explicit:
        found = shutil.which(explicit) or (explicit if Path(explicit).is_file() else None)
        return str(found) if found else None
    return shutil.which("ffmpeg")


class MediaManager:
    def __init__(self, catalog: Catalog, ffmpeg: str | None):
        self.catalog = catalog
        self.ffmpeg = ffmpeg
        self.cache = cache_root()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()

    def cached_mp4(self, work: Work) -> Path:
        stat = work.video.stat()
        key = hashlib.sha1(f"{work.video.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8", "surrogatepass")).hexdigest()
        return self.cache / f"{key}.mp4"

    def play_status(self, work_id: str) -> dict[str, Any] | None:
        work = self.catalog.works.get(work_id)
        if not work:
            return None
        if work.video.suffix.lower() in (".mp4", ".webm", ".mov"):
            return {"status": "ready", "url": f"/media/{work.id}?source=original", "cached": False}
        target = self.cached_mp4(work)
        if target.is_file() and target.stat().st_size:
            return {"status": "ready", "url": f"/media/{work.id}?source=cache", "cached": True}
        if not self.ffmpeg:
            return {"status": "fallback", "url": f"/media/{work.id}?source=original", "cached": False,
                    "message": "未检测到 FFmpeg，正在尝试浏览器直接播放 TS；Chrome/Edge 可能不支持。"}
        with self.lock:
            job = self.jobs.get(work_id)
            if job:
                return dict(job)
            self.jobs[work_id] = {"status": "queued", "message": "首次播放，正在无损封装为 MP4…"}
        threading.Thread(target=self._remux, args=(work, target), daemon=True).start()
        return dict(self.jobs[work_id])

    def _remux(self, work: Work, target: Path) -> None:
        part = target.with_suffix(".part.mp4")
        with self.lock:
            self.jobs[work.id] = {"status": "running", "message": "FFmpeg 正在无损封装，不会重新编码…"}
        try:
            base = [self.ffmpeg or "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts",
                    "-i", str(work.video), "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart",
                    "-avoid_negative_ts", "make_zero"]
            attempts = [[*base[:-4], "-bsf:a", "aac_adtstoasc", *base[-4:], str(part)], [*base, str(part)]]
            result = None
            for command in attempts:
                part.unlink(missing_ok=True)
                result = subprocess.run(command, capture_output=True, text=True, timeout=3600)
                if result.returncode == 0 and part.is_file() and part.stat().st_size:
                    break
            if result is None or result.returncode or not part.is_file() or not part.stat().st_size:
                raise RuntimeError(((result.stderr or result.stdout) if result else "FFmpeg 未生成文件").strip()[-1200:])
            os.replace(part, target)
            with self.lock:
                self.jobs[work.id] = {"status": "ready", "url": f"/media/{work.id}?source=cache", "cached": True,
                                      "message": "无损封装完成", "completedAt": time.time()}
        except Exception as exc:
            part.unlink(missing_ok=True)
            with self.lock:
                self.jobs[work.id] = {"status": "failed", "message": f"无损封装失败：{exc}",
                                      "fallbackUrl": f"/media/{work.id}?source=original"}

    def playable_path(self, work_id: str, source: str) -> Path | None:
        work = self.catalog.works.get(work_id)
        if not work:
            return None
        path = self.cached_mp4(work) if source == "cache" else work.video
        return path if path.is_file() else None

    def cover(self, work_id: str) -> tuple[Path | None, str]:
        work = self.catalog.works.get(work_id)
        if not work:
            return None, ""
        if work.cover and (mime := sniff_image_type(work.cover)):
            return work.cover, mime
        target = self.cache / f"thumb-{work.id}.jpg"
        if target.is_file() and target.stat().st_size:
            return target, "image/jpeg"
        if self.ffmpeg:
            self._thumbnail(work, target)
            if target.is_file() and target.stat().st_size:
                return target, "image/jpeg"
        return None, ""

    def _thumbnail(self, work: Work, target: Path) -> None:
        lock_file = target.with_suffix(".lock")
        try:
            descriptor = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(descriptor)
        except FileExistsError:
            return
        part = target.with_suffix(".part.jpg")
        try:
            result = subprocess.run([self.ffmpeg or "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "1",
                                     "-i", str(work.video), "-frames:v", "1", "-vf",
                                     "scale=720:-2:force_original_aspect_ratio=decrease", "-q:v", "3", str(part)],
                                    capture_output=True, text=True, timeout=90)
            if result.returncode == 0 and part.is_file() and part.stat().st_size:
                os.replace(part, target)
            else:
                part.unlink(missing_ok=True)
        except Exception:
            part.unlink(missing_ok=True)
        finally:
            lock_file.unlink(missing_ok=True)
