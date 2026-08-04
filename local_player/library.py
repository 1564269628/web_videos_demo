from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .catalog import Catalog, DEFAULT_SCAN_LIMIT
from .diagnostics import Diagnostics
from .media import MediaManager


class Library:
    def __init__(
        self,
        root: Path,
        ffmpeg: str | None,
        diagnostics: Diagnostics,
        scan_limit: int = DEFAULT_SCAN_LIMIT,
    ):
        self.catalog = Catalog(root, scan_limit=scan_limit)
        self.media = MediaManager(self.catalog, ffmpeg, diagnostics)
        self.ffmpeg = ffmpeg
        self.diagnostics = diagnostics

    @property
    def authors(self):
        return self.catalog.authors

    def scan(self) -> dict[str, Any]:
        started = time.time()
        self.diagnostics.event(
            "server",
            "catalog_scan_started",
            root=str(self.catalog.root),
            scanLimit=self.catalog.scan_limit,
        )
        try:
            self.catalog.scan()
            summary = self.summary()
            self.diagnostics.event(
                "server",
                "catalog_scan_completed",
                elapsedSeconds=round(time.time() - started, 3),
                summary=summary,
            )
            return summary
        except Exception as exc:
            self.diagnostics.exception(
                "server",
                "catalog_scan_failed",
                exc,
                root=str(self.catalog.root),
                scanLimit=self.catalog.scan_limit,
                elapsedSeconds=round(time.time() - started, 3),
            )
            raise

    def summary(self) -> dict[str, Any]:
        summary = self.catalog.summary(bool(self.ffmpeg))
        summary.update(
            {
                "logDir": str(self.diagnostics.log_dir),
                "logFiles": {
                    name: str(self.diagnostics.path(name))
                    for name in ("server", "http", "media", "browser")
                },
                "ffprobeAvailable": bool(self.media.ffprobe),
                "cacheDir": str(self.media.cache),
            }
        )
        return summary

    def feed(self, seed: str, offset: int, limit: int):
        return self.catalog.feed(seed, offset, limit)

    def author_payload(self, author_id: str, offset: int, limit: int):
        return self.catalog.author_payload(author_id, offset, limit)

    def public_work(self, work_id: str):
        return self.catalog.work_payload(work_id)

    def play_status(self, work_id: str):
        return self.media.play_status(work_id)

    def playable_path(self, work_id: str, source: str):
        return self.media.playable_path(work_id, source)

    def diagnostics_payload(self, work_id: str):
        return self.media.diagnostics_payload(work_id)

    def cover_path(self, work_id: str):
        return self.media.cover(work_id)
