from pathlib import Path
from typing import Any

from .catalog import Catalog
from .media import MediaManager


class Library:
    def __init__(self, root: Path, ffmpeg: str | None):
        self.catalog = Catalog(root)
        self.media = MediaManager(self.catalog, ffmpeg)
        self.ffmpeg = ffmpeg

    @property
    def authors(self):
        return self.catalog.authors

    def scan(self) -> dict[str, Any]:
        self.catalog.scan()
        return self.summary()

    def summary(self) -> dict[str, Any]:
        return self.catalog.summary(bool(self.ffmpeg))

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

    def cover_path(self, work_id: str):
        return self.media.cover(work_id)
