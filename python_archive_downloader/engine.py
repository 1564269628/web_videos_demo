from .common import *
class Downloader:
    def __init__(self,root,cfg,dry=False):
        self.root,self.c,self.dry=root,cfg,dry; self.stop=threading.Event(); self.local=threading.local()
        self.segpool=cf.ThreadPoolExecutor(max_workers=max(1,cfg["segment_workers"]),thread_name_prefix="seg")
        self.log=logging.getLogger("dl"); self.ev=root/"python-downloader-events.jsonl"; self.evlock=threading.Lock()
        self.total=0; self.ok=0; self.fail=0; self.statlock=threading.Lock(); self.started=time.monotonic()
    def event(self,name,**kw):
        with self.evlock:
            with self.ev.open("a",encoding="utf-8") as f:f.write(json.dumps({"time":time.strftime("%FT%T%z"),"event":name,**kw},ensure_ascii=False,default=str)+"\n")
    def session(self):
        if not hasattr(self.local,"s"):
            s=requests.Session(); a=HTTPAdapter(pool_connections=self.c["connection_pool"],pool_maxsize=self.c["connection_pool"],max_retries=0,pool_block=True)
            s.mount("http://",a); s.mount("https://",a); s.headers.update({"User-Agent":UA,"Accept":"*/*","Accept-Encoding":"gzip, deflate"}); self.local.s=s
        return self.local.s
    def check(self):
        if self.stop.is_set():raise StopNow()
    def response_problem(self,r,b):
        ct=(r.headers.get("content-type") or "").lower(); p=b[:700].lstrip().lower()
        if not b:return f"空响应 HTTP {r.status_code}"
        if "text/html" in ct or "application/json" in ct or p.startswith((b"<html",b"<!doctype html")) or b"<h1>404" in p:return f"错误页 HTTP {r.status_code} {ct}"
        if not r.ok:return f"HTTP {r.status_code}"
        return ""
    def get(self,url,headers=None):
        es=[]
        for n in range(self.c["retries"]):
            self.check()
            try:
                r=self.session().get(url,headers=headers or {},timeout=self.c["timeout"],verify=self.c["verify_tls"]); b=r.content; e=self.response_problem(r,b)
                if e:raise Retryable(e)
                return b
            except Exception as e:
                es.append(str(e)); time.sleep(.7*(n+1))
        raise Retryable(f"{url}："+"；".join(es))
    def media_candidates(self,url):
        if not url.startswith("http"):
            return uniq([urllib.parse.urljoin(b,url.lstrip("/")) for b in self.c["resource_bases"]])
        p=urllib.parse.urlsplit(url); path=re.sub(r"/{2,}","/",p.path); out=[url,urllib.parse.urlunsplit((p.scheme,p.netloc,path,p.query,""))]
        for b in self.c["resource_bases"]:
            q=urllib.parse.urlsplit(b); out.append(urllib.parse.urlunsplit((q.scheme,q.netloc,path,p.query,"")))
        return uniq(out)
    def media_get(self,url,headers=None):
        es=[]
        for u in self.media_candidates(url):
            try:return self.get(u,headers)
            except Exception as e:es.append(f"{u}:{e}")
        raise Retryable("资源不可用："+"；".join(es))
    def playlist_text(self,url):
        b=self.media_get(url,{"m":"1","Accept":"application/vnd.apple.mpegurl,*/*"}); tries=[b]
        for w in (zlib.MAX_WBITS,-zlib.MAX_WBITS,zlib.MAX_WBITS|16):
            with contextlib.suppress(zlib.error):tries.append(zlib.decompress(b,w))
        for x in tries:
            s=x.decode(errors="replace")
            if "#EXTM3U" in s:return s
        raise Retryable("不是有效 M3U8")
    def resolve(self,url):
        for _ in range(5):
            text=self.playlist_text(url); lines=text.splitlines(); vs=[]
            for i,l in enumerate(lines):
                if l.strip().startswith("#EXT-X-STREAM-INF:"):
                    a=attrs(l.split(":",1)[1]); j=i+1
                    while j<len(lines) and (not lines[j].strip() or lines[j].lstrip().startswith("#")):j+=1
                    if j<len(lines):vs.append((int(a.get("BANDWIDTH") or 0),urllib.parse.urljoin(url,lines[j].strip())))
            if vs:url=max(vs)[1]; continue
            seq=0; key=("NONE","",""); init=""; seg=[]
            for l in lines:
                l=l.strip()
                if l.startswith("#EXT-X-MEDIA-SEQUENCE:"):seq=int(l.split(":",1)[1] or 0)
                elif l.startswith("#EXT-X-KEY:"):
                    a=attrs(l.split(":",1)[1]); key=(a.get("METHOD","NONE"),a.get("URI",""),a.get("IV",""))
                elif l.startswith("#EXT-X-MAP:"):
                    a=attrs(l.split(":",1)[1]); init=urllib.parse.urljoin(url,a.get("URI","")) if a.get("URI") else ""
                elif l and not l.startswith("#"):seg.append((len(seg),urllib.parse.urljoin(url,l),seq,*key)); seq+=1
            if not seg:raise Retryable("M3U8 没有分片")
            ident=hashlib.sha256((str(len(seg))+"|"+"|".join(urllib.parse.urlsplit(x[1]).path for x in seg)).encode()).hexdigest()
            return {"url":url,"text":text,"segments":seg,"init":init,"id":ident}
        raise Retryable("M3U8 嵌套过深")
    def refresh(self,item):
        token=os.getenv(self.c["token_env"],"") or self.c["token"]
        if not token:raise RuntimeError("播放签名已失效，但没有 Token；请填写 python-downloader-config.json 的 token")
        es=[]
        for base in self.c["api_bases"]:
            for path in (f"videos/{item['id']}",f"shortVideos/{item['id']}",f"newsVideos/{item['id']}"):
                try:
                    r=self.session().get(urllib.parse.urljoin(base,path),params={"pid":self.c["pid"]},headers={"t":"2","k":"2","token":token,"version":self.c["version"]},timeout=self.c["timeout"])
                    r.raise_for_status(); v=playable(api_decrypt(r.json(),self.c["aes_key"]))
                    if v:return v
                except Exception as e:es.append(str(e))
        raise RuntimeError("刷新播放地址失败："+"；".join(es[-8:]))
    def scan(self):
        q=[]; authors=works=0
        self.log.info("开始扫描 %s",self.root)
        for ad in sorted([p for p in self.root.iterdir() if p.is_dir()]):
            wf=ad/"works.json"
            if not wf.is_file():continue
            authors+=1; aj=jread(ad/"author.json",{}); an=aj.get("username") or ad.name; uid=str(aj.get("uid") or "")
            wd=ad/"works"; wd.mkdir(exist_ok=True); dirs={}
            for p in wd.iterdir():
                if p.is_dir():
                    m=re.search(r"_([^_]+)$",p.name)
                    if m:dirs[m.group(1)]=p
                    mid=str(jread(p/"metadata.json",{}).get("id") or "")
                    if mid:dirs[mid]=p
            for i,x in enumerate(arr(jread(wf,[])),1):
                works+=1; w=norm_work(x,i)
                if not w["id"]:continue
                d=dirs.get(w["id"]) or wd/f"{w['index']:05d}_{clean(w['title'] or w['id'])}_{clean(w['id'],32)}"; d.mkdir(exist_ok=True)
                item={**w,"dir":d,"author":an,"uid":uid}
                if existing(d,VIDEO_NAMES) and existing(d,COVER_NAMES):continue
                q.append(item)
        self.log.info("扫描完成：作者 %d，作品 %d，待处理 %d",authors,works,len(q)); self.event("scan",authors=authors,works=works,queued=len(q)); return q
    def cover(self,item):
        if existing(item["dir"],COVER_NAMES) or not item["cover"]:return
        bases=list(self.c["resource_bases"])
        for u in item["urls"]:
            with contextlib.suppress(Exception):
                p=urllib.parse.urlsplit(u); bases.append(f"{p.scheme}://{p.netloc}/")
        urls=[item["cover"]] if item["cover"].startswith("http") else [urllib.parse.urljoin(b,item["cover"].lstrip("/")) for b in uniq(bases)]
        candidates=[]
        for u in urls:
            if re.search(r"\.(ceb|geb)($|[?#])",u,re.I):candidates.append(u+"@webp-720")
            candidates.append(u)
        es=[]
        for u in uniq(candidates):
            try:b=self.get(u,{"Accept":"image/avif,image/webp,image/*,*/*"}); b,ext=decode_image(b,self.c["image_aes_key"]); bwrite(item["dir"]/f"cover.{ext}",b); self.log.info("封面完成：%s / %s",item["author"],item["title"]); return
            except Exception as e:es.append(str(e))
        raise RuntimeError("封面失败："+"；".join(es))
    def seg_download(self,item,pl,s,parts):
        i,url,seq,method,kuri,kiv=s; p=parts/f"{i:08d}.part"
        if p.is_file() and p.stat().st_size:return p.stat().st_size
        b=self.media_get(url)
        if method.upper()=="AES-128":
            key=base64.b64decode(self.c["media_key_base64"])
            if kuri:
                with contextlib.suppress(Exception):
                    k=self.media_get(urllib.parse.urljoin(pl["url"],kuri)); key=k if len(k)==16 else key
            b=decrypt_cbc(b,key,iv_bytes(kiv,seq))
        elif method.upper() not in ("NONE",""):raise RuntimeError("不支持加密："+method)
        bwrite(p,b); return len(b)
    def download_playlist(self,item,pl):
        d=item["dir"]; parts=d/".parts"; parts.mkdir(exist_ok=True); st=jread(parts/"state.json",{})
        if st.get("id")!=pl["id"]:shutil.rmtree(parts,ignore_errors=True); parts.mkdir()
        jwrite(parts/"state.json",{"id":pl["id"],"url":pl["url"],"count":len(pl["segments"])}); (d/"playlist.m3u8").write_text(pl["text"],encoding="utf-8")
        init=None
        if pl["init"]:
            init=parts/"init.bin"
            if not init.exists():bwrite(init,self.media_get(pl["init"]))
        todo=iter([s for s in pl["segments"] if not (parts/f"{s[0]:08d}.part").exists()]); active={}; done=sum((parts/f"{s[0]:08d}.part").exists() for s in pl["segments"]); last=time.monotonic()
        def fill():
            while len(active)<self.c["per_video_inflight"]:
                try:s=next(todo)
                except StopIteration:return
                active[self.segpool.submit(self.seg_download,item,pl,s,parts)]=s
        fill()
        while active:
            self.check(); ready,_=cf.wait(active,timeout=1,return_when=cf.FIRST_COMPLETED)
            for f in ready:f.result(); active.pop(f); done+=1
            fill()
            if time.monotonic()-last>3:self.log.info("下载中：%s / %s %d/%d",item["author"],item["title"],done,len(pl["segments"])); last=time.monotonic()
        name="video.mp4" if init else "video.ts"; tmp=d/(name+".tmp")
        with tmp.open("wb") as out:
            if init:
                with init.open("rb") as f:shutil.copyfileobj(f,out,1024*1024)
            for s in pl["segments"]:
                with (parts/f"{s[0]:08d}.part").open("rb") as f:shutil.copyfileobj(f,out,1024*1024)
            out.flush(); os.fsync(out.fileno())
        os.replace(tmp,d/name); jwrite(d/"download.json",{"version":VERSION,"fileName":name,"byteLength":(d/name).stat().st_size,"segmentCount":len(pl["segments"]),"playlistUrl":pl["url"],"completedAt":time.strftime("%FT%T%z")}); shutil.rmtree(parts,ignore_errors=True); return d/name
    def work(self,item):
        started=time.monotonic()
        try:
            v=existing(item["dir"],VIDEO_NAMES)
            if v:self.cover(item); return
            if self.dry:self.log.info("[DRY] %s / %s",item["author"],item["title"]); return
            jwrite(item["dir"]/"metadata.json",item)
            err=None
            for n in range(1+self.c["refresh_attempts"]):
                try:
                    if n==0:
                        pl=None; es=[]
                        for u in item["urls"]:
                            for x in self.media_candidates(u):
                                try:pl=self.resolve(x); break
                                except Exception as e:es.append(str(e))
                            if pl:break
                        if not pl:pl=self.resolve(self.refresh(item))
                    else:self.log.warning("刷新过期签名：%s / %s",item["author"],item["title"]); pl=self.resolve(self.refresh(item))
                    out=self.download_playlist(item,pl); self.cover(item)
                    with self.statlock:self.ok+=1; self.total+=out.stat().st_size
                    self.log.info("完成：%s / %s %s",item["author"],item["title"],fmt(out.stat().st_size)); self.event("completed",id=item["id"],author=item["author"],title=item["title"],bytes=out.stat().st_size); return
                except Exception as e:err=e; self.log.warning("尝试 %d 失败：%s / %s：%s",n+1,item["author"],item["title"],e)
            raise err or RuntimeError("未知错误")
        except StopNow:raise
        except Exception as e:
            with self.statlock:self.fail+=1
            jwrite(item["dir"]/"download-error.json",{"version":VERSION,"time":time.strftime("%FT%T%z"),"author":item["author"],"id":item["id"],"title":item["title"],"error":str(e),"traceback":traceback.format_exc()}); self.log.error("失败：%s / %s：%s",item["author"],item["title"],e); self.event("failed",id=item["id"],error=str(e))
    def run(self,q):
        if not q:return
        with cf.ThreadPoolExecutor(max_workers=min(self.c["video_workers"],len(q)),thread_name_prefix="video") as p:
            fs=[p.submit(self.work,x) for x in q]
            for f in cf.as_completed(fs):
                try:f.result()
                except StopNow:self.stop.set()
        self.log.info("队列结束：成功 %d，失败 %d，下载 %s",self.ok,self.fail,fmt(self.total))
    def close(self):self.stop.set(); self.segpool.shutdown(wait=True,cancel_futures=True)
