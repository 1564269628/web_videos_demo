from __future__ import annotations

import hashlib
import json
import random
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

APP_VERSION = "2026.08.04.5"
DEFAULT_ROOT = Path(r"F:\tools\short_videos")
DEFAULT_PORT = 8765
DEFAULT_SCAN_LIMIT = 50
VIDEO_NAMES = ("video.mp4", "video.ts", "video.webm", "video.mkv", "video.mov")
COVER_NAMES = ("cover.webp", "cover.jpg", "cover.jpeg", "cover.png", "cover.avif", "cover.gif", "cover.bin")
IMAGE_EXTENSIONS = (".webp", ".jpg", ".jpeg", ".png", ".avif", ".gif", ".bin")


def read_json(path: Path, fallback: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return fallback


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return default


def first_nonempty(*values: Any) -> str:
    for value in values:
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def normalize_work(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict) and isinstance(raw.get("video"), dict):
        raw = {**raw["video"], **{key: value for key, value in raw.items() if key != "video"}}
    return raw if isinstance(raw, dict) else {}


def compact_count(value: int) -> str:
    if value >= 100_000_000:
        return f"{value / 100_000_000:.1f}亿".rstrip("0").rstrip(".")
    if value >= 10_000:
        return f"{value / 10_000:.1f}万".rstrip("0").rstrip(".")
    return str(value)


def file_id(path: Path) -> str:
    return hashlib.sha1(str(path.resolve()).encode("utf-8", "surrogatepass")).hexdigest()[:20]


def find_first_file(directory: Path, names: Iterable[str]) -> Path | None:
    for name in names:
        candidate = directory / name
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    return None


def sniff_image_type(path: Path) -> str:
    try:
        with path.open("rb") as source:
            head = source.read(32)
    except OSError:
        return ""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if len(head) >= 12 and head[4:8] == b"ftyp" and head[8:12] in (b"avif", b"avis"):
        return "image/avif"
    return ""


def find_avatar(author_dir: Path) -> Path | None:
    assets = author_dir / "assets"
    if not assets.is_dir():
        return None
    try:
        files = [path for path in assets.iterdir() if path.is_file()]
    except OSError:
        return None
    for prefix in ("avatar", "head", "profile"):
        for path in files:
            if path.stem.lower().startswith(prefix) and path.suffix.lower() in IMAGE_EXTENSIONS:
                return path
    return next((path for path in files if path.suffix.lower() in IMAGE_EXTENSIONS), None)


def folder_identity(folder_name: str) -> tuple[str, str]:
    match = re.match(r"^(.*)_UID(.+)$", folder_name, re.I)
    return (match.group(1).strip() or folder_name, match.group(2).strip()) if match else (folder_name, "")


@dataclass(slots=True)
class Author:
    id: str
    folder_name: str
    folder: Path
    name: str
    uid: str
    signature: str = ""
    video_count: int = 0
    follower_count: int = 0
    liked_count: int = 0
    collect_count: int = 0
    avatar: Path | None = None
    works: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "folderName": self.folder_name,
            "name": self.name,
            "uid": self.uid,
            "signature": self.signature,
            "videoCount": self.video_count,
            "downloadedCount": len(self.works),
            "followerCount": self.follower_count,
            "likedCount": self.liked_count,
            "collectCount": self.collect_count,
            "followerCountLabel": compact_count(self.follower_count),
            "likedCountLabel": compact_count(self.liked_count),
            "collectCountLabel": compact_count(self.collect_count),
            "avatarUrl": f"/avatar/{self.id}",
        }


@dataclass(slots=True)
class Work:
    id: str
    author_id: str
    folder: Path
    video: Path
    cover: Path | None
    index: int
    source_id: str
    title: str
    description: str
    duration: int
    width: int
    height: int
    play_count: int
    like_count: int
    comment_count: int
    collect_count: int
    release_date: str
    tags: list[str]

    def public(self, author: Author) -> dict[str, Any]:
        return {
            "id": self.id,
            "sourceId": self.source_id,
            "index": self.index,
            "title": self.title,
            "description": self.description,
            "duration": self.duration,
            "width": self.width,
            "height": self.height,
            "playCount": self.play_count,
            "likeCount": self.like_count,
            "commentCount": self.comment_count,
            "collectCount": self.collect_count,
            "playCountLabel": compact_count(self.play_count),
            "likeCountLabel": compact_count(self.like_count),
            "commentCountLabel": compact_count(self.comment_count),
            "collectCountLabel": compact_count(self.collect_count),
            "releaseDate": self.release_date,
            "tags": self.tags,
            "coverUrl": f"/cover/{self.id}",
            "fileType": self.video.suffix.lower().lstrip("."),
            "author": {
                "id": author.id,
                "name": author.name,
                "uid": author.uid,
                "avatarUrl": f"/avatar/{author.id}",
            },
        }


class Catalog:
    def __init__(self, root: Path, scan_limit: int = DEFAULT_SCAN_LIMIT):
        self.root = root.resolve()
        self.scan_limit = max(0, int(scan_limit))
        self.authors: dict[str, Author] = {}
        self.works: dict[str, Work] = {}
        self.work_order: list[str] = []
        self.lock = threading.RLock()
        self.scanned_at = 0.0
        self.scan_limit_reached = False
        self.scanned_author_dirs = 0

    def _limit_reached(self, count: int) -> bool:
        return self.scan_limit > 0 and count >= self.scan_limit

    def scan(self) -> None:
        if not self.root.is_dir():
            raise FileNotFoundError(f"归档目录不存在：{self.root}")

        authors: dict[str, Author] = {}
        works: dict[str, Work] = {}
        order: list[str] = []
        scanned_author_dirs = 0
        limit_reached = False

        author_dirs = sorted(
            (path for path in self.root.iterdir() if path.is_dir()),
            key=lambda path: path.name.lower(),
        )
        for author_dir in author_dirs:
            if self._limit_reached(len(works)):
                limit_reached = True
                break
            if author_dir.name.startswith("."):
                continue

            works_dir = author_dir / "works"
            if not works_dir.is_dir():
                continue
            works_json = read_json(author_dir / "works.json", []) or []
            if not isinstance(works_json, list):
                continue

            scanned_author_dirs += 1
            author_json = read_json(author_dir / "author.json", {}) or {}
            fallback_name, fallback_uid = folder_identity(author_dir.name)
            author_id = file_id(author_dir)
            author = Author(
                author_id,
                author_dir.name,
                author_dir,
                first_nonempty(author_json.get("username"), fallback_name),
                first_nonempty(author_json.get("uid"), author_json.get("id"), fallback_uid),
                first_nonempty(author_json.get("signature"), author_json.get("introduce")),
                safe_int(author_json.get("videoCount") or author_json.get("videoCnt")),
                safe_int(author_json.get("followerCount") or author_json.get("followerCnt")),
                safe_int(author_json.get("likedCount") or author_json.get("likedCnt")),
                safe_int(author_json.get("collectCount") or author_json.get("collectCnt")),
                find_avatar(author_dir),
            )

            by_id: dict[str, dict[str, Any]] = {}
            by_index: dict[int, dict[str, Any]] = {}
            for number, raw in enumerate(works_json, 1):
                item = normalize_work(raw)
                source_id = first_nonempty(item.get("id"), item.get("videoId"), item.get("vid"))
                index = safe_int(item.get("index"), number)
                if source_id:
                    by_id[source_id] = item
                by_index[index] = item

            try:
                work_dirs = works_dir.iterdir()
            except OSError:
                continue

            for work_dir in work_dirs:
                if not work_dir.is_dir():
                    continue
                if self._limit_reached(len(works)):
                    limit_reached = True
                    break
                video = find_first_file(work_dir, VIDEO_NAMES)
                if not video:
                    continue

                metadata = normalize_work(read_json(work_dir / "metadata.json", {}) or {})
                raw_metadata = normalize_work(read_json(work_dir / "metadata.raw.json", {}) or {})
                match = re.match(r"^(\d{1,8})_", work_dir.name)
                folder_index = safe_int(match.group(1), 0) if match else 0
                source_id = first_nonempty(
                    metadata.get("id"),
                    raw_metadata.get("id"),
                    work_dir.name.rsplit("_", 1)[-1],
                )
                merged = {
                    **(by_id.get(source_id) or by_index.get(folder_index) or {}),
                    **raw_metadata,
                    **metadata,
                }
                source_id = first_nonempty(
                    merged.get("id"), merged.get("videoId"), merged.get("vid"), source_id
                )
                tags: list[str] = []
                for tag in merged.get("tags") or merged.get("videoTags") or []:
                    value = tag if isinstance(tag, str) else tag.get("name") if isinstance(tag, dict) else ""
                    if value and str(value).strip() not in tags:
                        tags.append(str(value).strip())

                work_id = file_id(work_dir)
                work = Work(
                    work_id,
                    author_id,
                    work_dir,
                    video,
                    find_first_file(work_dir, COVER_NAMES),
                    safe_int(merged.get("index"), folder_index or len(author.works) + 1),
                    source_id,
                    first_nonempty(merged.get("title"), merged.get("name"), work_dir.name),
                    first_nonempty(merged.get("description"), merged.get("introduce")),
                    safe_int(merged.get("durationSeconds") or merged.get("time") or merged.get("duration")),
                    safe_int(merged.get("width")),
                    safe_int(merged.get("height")),
                    safe_int(merged.get("playCount") or merged.get("playCnt")),
                    safe_int(merged.get("likeCount") or merged.get("likedCnt")),
                    safe_int(merged.get("commentCount") or merged.get("commentCnt")),
                    safe_int(merged.get("collectCount") or merged.get("collectedCnt")),
                    first_nonempty(merged.get("releaseDateLabel"), merged.get("releaseDate")),
                    tags,
                )
                works[work_id] = work
                order.append(work_id)
                author.works.append(work_id)

            if author.works:
                author.video_count = author.video_count or len(author.works)
                authors[author_id] = author
            if limit_reached:
                break

        with self.lock:
            self.authors = authors
            self.works = works
            self.work_order = order
            self.scanned_at = time.time()
            self.scan_limit_reached = limit_reached
            self.scanned_author_dirs = scanned_author_dirs

    def summary(self, ffmpeg_available: bool) -> dict[str, Any]:
        with self.lock:
            total_bytes = 0
            for work in self.works.values():
                try:
                    total_bytes += work.video.stat().st_size
                except OSError:
                    pass
            return {
                "version": APP_VERSION,
                "root": str(self.root),
                "authorCount": len(self.authors),
                "videoCount": len(self.works),
                "totalBytes": total_bytes,
                "ffmpegAvailable": ffmpeg_available,
                "scannedAt": self.scanned_at,
                "scanLimit": self.scan_limit,
                "scanLimitReached": self.scan_limit_reached,
                "scannedAuthorDirs": self.scanned_author_dirs,
            }

    def work_payload(self, work_id: str) -> dict[str, Any] | None:
        with self.lock:
            work = self.works.get(work_id)
            return work.public(self.authors[work.author_id]) if work else None

    def feed(self, seed: str, offset: int, limit: int) -> dict[str, Any]:
        with self.lock:
            ids = list(self.work_order)
            random.Random(seed).shuffle(ids)
            selected = ids[max(0, offset):max(0, offset) + max(1, min(limit, 100))]
            return {
                "items": [self.works[item].public(self.authors[self.works[item].author_id]) for item in selected],
                "offset": offset,
                "limit": limit,
                "total": len(ids),
                "hasMore": offset + len(selected) < len(ids),
                "seed": seed,
            }

    def author_payload(self, author_id: str, offset: int, limit: int) -> dict[str, Any] | None:
        with self.lock:
            author = self.authors.get(author_id)
            if not author:
                return None
            ordered = sorted(
                (self.works[item] for item in author.works if item in self.works),
                key=lambda work: (work.index, work.title),
            )
            start = max(0, offset)
            selected = ordered[start:start + max(1, min(limit, 200))]
            return {
                "author": author.public(),
                "items": [work.public(author) for work in selected],
                "offset": offset,
                "limit": limit,
                "total": len(ordered),
                "hasMore": start + len(selected) < len(ordered),
                "scanLimit": self.scan_limit,
                "scanLimitReached": self.scan_limit_reached,
            }
