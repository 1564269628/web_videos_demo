from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from .catalog import Catalog, Work, sniff_image_type
from .diagnostics import Diagnostics


def cache_root() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "ShortVideosLocalPlayer" / "cache"


def find_ffmpeg(explicit: str | None) -> str | None:
    if explicit:
        found = shutil.which(explicit) or (explicit if Path(explicit).is_file() else None)
        return str(Path(found).resolve()) if found else None
    found = shutil.which("ffmpeg")
    return str(Path(found).resolve()) if found else None


def find_ffprobe(ffmpeg: str | None) -> str | None:
    found = shutil.which("ffprobe")
    if found:
        return str(Path(found).resolve())
    if ffmpeg:
        sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
        if sibling.is_file():
            return str(sibling.resolve())
    return None


def media_mime(path: Path) -> str:
    return {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".ts": "video/mp2t",
        ".mkv": "video/x-matroska",
    }.get(path.suffix.lower(), "application/octet-stream")


class MediaManager:
    def __init__(self, catalog: Catalog, ffmpeg: str | None, diagnostics: Diagnostics):
        self.catalog = catalog
        self.ffmpeg = ffmpeg
        self.ffprobe = find_ffprobe(ffmpeg)
        self.diagnostics = diagnostics
        self.cache = cache_root()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.probe_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        self.lock = threading.RLock()
        self.diagnostics.event(
            "media",
            "media_manager_ready",
            cacheDir=str(self.cache),
            ffmpeg=self.ffmpeg,
            ffprobe=self.ffprobe,
        )

    def cached_mp4(self, work: Work) -> Path:
        stat = work.video.stat()
        key = hashlib.sha1(
            f"{work.video.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8", "surrogatepass")
        ).hexdigest()
        return self.cache / f"{key}.mp4"

    def play_status(self, work_id: str) -> dict[str, Any] | None:
        work = self.catalog.works.get(work_id)
        if not work:
            self.diagnostics.event("media", "play_status_missing_work", workId=work_id)
            return None
        source_stat = work.video.stat()
        self.diagnostics.event(
            "media",
            "play_status_requested",
            workId=work.id,
            title=work.title,
            sourcePath=str(work.video),
            sourceSuffix=work.video.suffix.lower(),
            sourceBytes=source_stat.st_size,
        )
        if work.video.suffix.lower() in (".mp4", ".webm", ".mov"):
            return self._ready_payload(work, work.video, "original", False)
        target = self.cached_mp4(work)
        if target.is_file() and target.stat().st_size:
            return self._ready_payload(work, target, "cache", True)
        if not self.ffmpeg:
            self.diagnostics.event("media", "ffmpeg_unavailable", workId=work.id, sourcePath=str(work.video))
            return {
                "status": "failed",
                "message": "未检测到 FFmpeg，浏览器无法可靠播放 TS。请安装 FFmpeg 后重启播放器。",
                "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
            }
        with self.lock:
            job = self.jobs.get(work_id)
            if job and job.get("status") in ("queued", "running"):
                return dict(job)
            if job and job.get("status") == "failed":
                return dict(job)
            self.jobs[work_id] = {
                "status": "queued",
                "message": "首次播放，正在无损封装为 MP4…",
                "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
            }
        self.diagnostics.event("media", "remux_queued", workId=work.id, targetPath=str(target))
        threading.Thread(target=self._remux, args=(work, target), daemon=True, name=f"remux-{work.id}").start()
        return dict(self.jobs[work_id])

    def _ready_payload(self, work: Work, path: Path, source: str, cached: bool) -> dict[str, Any]:
        probe = self.probe(path)
        warning = self._compatibility_warning(probe)
        payload: dict[str, Any] = {
            "status": "ready",
            "url": f"/media/{work.id}?source={source}",
            "cached": cached,
            "mime": media_mime(path),
            "bytes": path.stat().st_size,
            "probe": self._probe_summary(probe),
            "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
        }
        if warning:
            payload["warning"] = warning
        self.diagnostics.event(
            "media",
            "media_ready",
            workId=work.id,
            source=source,
            path=str(path),
            bytes=path.stat().st_size,
            mime=media_mime(path),
            probe=payload["probe"],
            warning=warning,
        )
        return payload

    def _remux(self, work: Work, target: Path) -> None:
        part = target.with_suffix(".part.mp4")
        started = time.time()
        with self.lock:
            self.jobs[work.id] = {
                "status": "running",
                "message": "FFmpeg 正在无损封装，不会重新编码…",
                "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
            }
        base = [
            self.ffmpeg or "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-y",
            "-fflags",
            "+genpts",
            "-i",
            str(work.video),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
        ]
        attempts = [
            [*base[:-4], "-bsf:a", "aac_adtstoasc", *base[-4:], str(part)],
            [*base, str(part)],
        ]
        result: subprocess.CompletedProcess[str] | None = None
        try:
            source_probe = self.probe(work.video, refresh=True)
            self.diagnostics.event(
                "media",
                "remux_started",
                workId=work.id,
                title=work.title,
                sourcePath=str(work.video),
                sourceBytes=work.video.stat().st_size,
                sourceProbe=source_probe,
                targetPath=str(target),
            )
            for attempt_number, command in enumerate(attempts, 1):
                part.unlink(missing_ok=True)
                self.diagnostics.event(
                    "media",
                    "ffmpeg_attempt_started",
                    workId=work.id,
                    attempt=attempt_number,
                    command=command,
                )
                result = subprocess.run(command, capture_output=True, text=True, timeout=3600)
                self.diagnostics.event(
                    "media",
                    "ffmpeg_attempt_finished",
                    workId=work.id,
                    attempt=attempt_number,
                    returnCode=result.returncode,
                    elapsedSeconds=round(time.time() - started, 3),
                    stdout=result.stdout,
                    stderr=result.stderr,
                    partExists=part.is_file(),
                    partBytes=part.stat().st_size if part.is_file() else 0,
                )
                if result.returncode == 0 and part.is_file() and part.stat().st_size:
                    break
            if result is None or result.returncode or not part.is_file() or not part.stat().st_size:
                detail = ((result.stderr or result.stdout) if result else "FFmpeg 未生成文件").strip()
                raise RuntimeError(detail[-4000:])
            os.replace(part, target)
            target_probe = self.probe(target, refresh=True)
            warning = self._compatibility_warning(target_probe)
            with self.lock:
                self.jobs[work.id] = {
                    "status": "ready",
                    "url": f"/media/{work.id}?source=cache",
                    "cached": True,
                    "mime": "video/mp4",
                    "bytes": target.stat().st_size,
                    "probe": self._probe_summary(target_probe),
                    "warning": warning,
                    "message": "无损封装完成",
                    "completedAt": time.time(),
                    "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
                }
            self.diagnostics.event(
                "media",
                "remux_completed",
                workId=work.id,
                targetPath=str(target),
                targetBytes=target.stat().st_size,
                elapsedSeconds=round(time.time() - started, 3),
                targetProbe=target_probe,
                warning=warning,
            )
        except Exception as exc:
            part.unlink(missing_ok=True)
            self.diagnostics.exception(
                "media",
                "remux_failed",
                exc,
                workId=work.id,
                sourcePath=str(work.video),
                targetPath=str(target),
                elapsedSeconds=round(time.time() - started, 3),
            )
            with self.lock:
                self.jobs[work.id] = {
                    "status": "failed",
                    "message": f"无损封装失败：{exc}",
                    "diagnosticsUrl": f"/api/diagnostics?id={work.id}",
                }

    def playable_path(self, work_id: str, source: str) -> Path | None:
        work = self.catalog.works.get(work_id)
        if not work:
            return None
        path = self.cached_mp4(work) if source == "cache" else work.video
        if not path.is_file():
            self.diagnostics.event(
                "media",
                "playable_path_missing",
                workId=work_id,
                source=source,
                expectedPath=str(path),
            )
            return None
        return path

    def diagnostics_payload(self, work_id: str) -> dict[str, Any] | None:
        work = self.catalog.works.get(work_id)
        if not work:
            return None
        cache = self.cached_mp4(work)
        source_probe = self.probe(work.video)
        cache_probe = self.probe(cache) if cache.is_file() else {}
        return {
            "workId": work.id,
            "title": work.title,
            "source": self._file_details(work.video, source_probe),
            "cache": self._file_details(cache, cache_probe) if cache.is_file() else {"path": str(cache), "exists": False},
            "job": dict(self.jobs.get(work.id) or {}),
            "ffmpeg": self.ffmpeg,
            "ffprobe": self.ffprobe,
            "cacheDir": str(self.cache),
            "compatibilityWarning": self._compatibility_warning(cache_probe or source_probe),
        }

    def _file_details(self, path: Path, probe: dict[str, Any]) -> dict[str, Any]:
        return {
            "path": str(path),
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else 0,
            "modifiedAt": path.stat().st_mtime if path.is_file() else None,
            "suffix": path.suffix.lower(),
            "mime": media_mime(path),
            "probe": probe,
        }

    def probe(self, path: Path, refresh: bool = False) -> dict[str, Any]:
        if not path.is_file():
            return {"error": "file_not_found", "path": str(path)}
        stat = path.stat()
        fingerprint = (stat.st_size, stat.st_mtime_ns)
        key = str(path.resolve())
        cached = self.probe_cache.get(key)
        if cached and cached[0] == fingerprint and not refresh:
            return cached[1]
        if not self.ffprobe:
            result = {"error": "ffprobe_not_found", "path": str(path)}
            self.probe_cache[key] = (fingerprint, result)
            return result
        command = [
            self.ffprobe,
            "-v",
            "error",
            "-show_error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ]
        started = time.time()
        try:
            completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
            if completed.returncode:
                result = {
                    "error": "ffprobe_failed",
                    "returnCode": completed.returncode,
                    "stderr": completed.stderr[-4000:],
                }
            else:
                result = json.loads(completed.stdout or "{}")
            self.diagnostics.event(
                "media",
                "ffprobe_finished",
                path=str(path),
                bytes=stat.st_size,
                returnCode=completed.returncode,
                elapsedSeconds=round(time.time() - started, 3),
                result=result,
                stderr=completed.stderr,
            )
        except Exception as exc:
            result = {"error": type(exc).__name__, "message": str(exc)}
            self.diagnostics.exception("media", "ffprobe_exception", exc, path=str(path))
        self.probe_cache[key] = (fingerprint, result)
        return result

    @staticmethod
    def _probe_summary(probe: dict[str, Any]) -> dict[str, Any]:
        streams = probe.get("streams") if isinstance(probe, dict) else []
        streams = streams if isinstance(streams, list) else []
        return {
            "format": (probe.get("format") or {}).get("format_name") if isinstance(probe, dict) else None,
            "duration": (probe.get("format") or {}).get("duration") if isinstance(probe, dict) else None,
            "streams": [
                {
                    key: stream.get(key)
                    for key in (
                        "index",
                        "codec_type",
                        "codec_name",
                        "codec_long_name",
                        "profile",
                        "pix_fmt",
                        "width",
                        "height",
                        "avg_frame_rate",
                        "sample_rate",
                        "channels",
                    )
                }
                for stream in streams
                if isinstance(stream, dict)
            ],
            "error": probe.get("error") if isinstance(probe, dict) else "invalid_probe",
        }

    @staticmethod
    def _compatibility_warning(probe: dict[str, Any]) -> str:
        streams = probe.get("streams") if isinstance(probe, dict) else []
        codecs = {
            str(stream.get("codec_name") or "").lower()
            for stream in (streams if isinstance(streams, list) else [])
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        }
        if codecs & {"hevc", "h265"}:
            return "检测到 HEVC/H.265 视频。当前 Edge/Windows 若缺少 HEVC 解码组件，可能只有黑屏或无法播放。"
        if codecs and not codecs <= {"h264", "av1", "vp8", "vp9"}:
            return f"视频编码为 {', '.join(sorted(codecs))}，浏览器兼容性可能有限。"
        return ""

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
        started = time.time()
        try:
            command = [
                self.ffmpeg or "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                "1",
                "-i",
                str(work.video),
                "-frames:v",
                "1",
                "-vf",
                "scale=720:-2:force_original_aspect_ratio=decrease",
                "-q:v",
                "3",
                str(part),
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=90)
            self.diagnostics.event(
                "media",
                "thumbnail_finished",
                workId=work.id,
                returnCode=result.returncode,
                elapsedSeconds=round(time.time() - started, 3),
                command=command,
                stderr=result.stderr,
                outputBytes=part.stat().st_size if part.is_file() else 0,
            )
            if result.returncode == 0 and part.is_file() and part.stat().st_size:
                os.replace(part, target)
            else:
                part.unlink(missing_ok=True)
        except Exception as exc:
            part.unlink(missing_ok=True)
            self.diagnostics.exception("media", "thumbnail_failed", exc, workId=work.id)
        finally:
            lock_file.unlink(missing_ok=True)
