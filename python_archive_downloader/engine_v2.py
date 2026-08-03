from .common import *
from .engine import Downloader as BaseDownloader

class Downloader(BaseDownloader):
    def cover(self,item):
        if existing(item["dir"],COVER_NAMES):return
        if not item["cover"]:
            self.log.warning("缺少封面地址：%s / %s",item["author"],item["title"]); return
        return super().cover(item)

    def work(self,item):
        try:
            video=existing(item["dir"],VIDEO_NAMES)
            if video:
                self.cover(item); return
            if self.dry:
                self.log.info("[DRY] %s / %s",item["author"],item["title"]); return
            jwrite(item["dir"]/"metadata.json",item)
            error=None; output=None
            for attempt in range(1+self.c["refresh_attempts"]):
                try:
                    if attempt==0:
                        playlist=None
                        for url in item["urls"]:
                            for candidate in self.media_candidates(url):
                                try:playlist=self.resolve(candidate); break
                                except Exception:pass
                            if playlist:break
                        if not playlist:playlist=self.resolve(self.refresh(item))
                    else:
                        self.log.warning("刷新过期签名：%s / %s",item["author"],item["title"])
                        playlist=self.resolve(self.refresh(item))
                    output=self.download_playlist(item,playlist); break
                except Exception as exc:
                    error=exc
                    self.log.warning("尝试 %d 失败：%s / %s：%s",attempt+1,item["author"],item["title"],exc)
            if output is None:raise error or RuntimeError("未知错误")
            self.cover(item)
            with self.statlock:self.ok+=1; self.total+=output.stat().st_size
            self.log.info("完成：%s / %s %s",item["author"],item["title"],fmt(output.stat().st_size))
            self.event("completed",id=item["id"],author=item["author"],title=item["title"],bytes=output.stat().st_size)
        except StopNow:raise
        except Exception as exc:
            with self.statlock:self.fail+=1
            jwrite(item["dir"]/"download-error.json",{"version":VERSION,"time":time.strftime("%FT%T%z"),"author":item["author"],"id":item["id"],"title":item["title"],"error":str(exc),"traceback":traceback.format_exc()})
            self.log.error("失败：%s / %s：%s",item["author"],item["title"],exc)
            self.event("failed",id=item["id"],error=str(exc))
