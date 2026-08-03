from .common import *
from .engine import Downloader
def logger(root,verbose):
    l=logging.getLogger("dl"); l.setLevel(logging.DEBUG); l.handlers.clear(); fm=logging.Formatter("%(asctime)s.%(msecs)03d [%(levelname)s] [%(threadName)s] %(message)s","%Y-%m-%d %H:%M:%S")
    c=logging.StreamHandler(sys.stdout); c.setLevel(logging.DEBUG if verbose else logging.INFO); c.setFormatter(fm); l.addHandler(c)
    f=logging.handlers.RotatingFileHandler(root/"python-downloader.log",maxBytes=20*1024*1024,backupCount=5,encoding="utf-8"); f.setLevel(logging.DEBUG); f.setFormatter(fm); l.addHandler(f); return l

def load_cfg(root,args):
    p=root/"python-downloader-config.json"
    if not p.exists():jwrite(p,{**DEFAULTS,"notes":{"token":"旧签名失效时填写；也可设置 HQ_VIDEO_TOKEN","scan":"下载期间不会重新扫描；--watch 只在队列结束后扫描"}})
    c={**DEFAULTS,**jread(p,{})}
    for a,k in (("video_workers","video_workers"),("segment_workers","segment_workers"),("per_video_inflight","per_video_inflight"),("connections","connection_pool")):
        v=getattr(args,a)
        if v is not None:c[k]=max(1,v)
    return c

def main():
    a=argparse.ArgumentParser(); a.add_argument("--root",type=Path,default=ROOT_DEFAULT); a.add_argument("--watch",action="store_true"); a.add_argument("--dry-run",action="store_true"); a.add_argument("--verbose",action="store_true"); a.add_argument("--video-workers",type=int); a.add_argument("--segment-workers",type=int); a.add_argument("--per-video-inflight",type=int); a.add_argument("--connections",type=int); x=a.parse_args()
    root=x.root.expanduser().resolve(); root.mkdir(parents=True,exist_ok=True); c=load_cfg(root,x); log=logger(root,x.verbose); log.info("%s 启动；目录 %s",VERSION,root)
    with Lock(root/".python-downloader.lock"):
        d=Downloader(root,c,x.dry_run)
        def stop(*_):d.stop.set(); log.warning("收到停止请求")
        signal.signal(signal.SIGINT,stop)
        if hasattr(signal,"SIGTERM"):signal.signal(signal.SIGTERM,stop)
        try:
            while not d.stop.is_set():
                d.run(d.scan())
                if not x.watch:break
                log.info("队列结束，%s 秒后重新扫描；等待和下载期间不会全盘扫描",c["watch_interval"]); d.stop.wait(c["watch_interval"])
        finally:d.close()
