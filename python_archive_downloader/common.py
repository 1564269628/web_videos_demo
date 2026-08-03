#!/usr/bin/env python3
"""扫描 F:\\tools\\short_videos，并行下载 works.json 中的视频和封面。
依赖：py -m pip install requests cryptography
运行：py local_archive_downloader.py [--watch] [--root F:\\tools\\short_videos]
"""
from __future__ import annotations
import argparse, base64, concurrent.futures as cf, contextlib, hashlib, json, logging
import logging.handlers, os, re, shutil, signal, sys, threading, time, traceback
import urllib.parse, zlib
from pathlib import Path
try:
    import requests
    from requests.adapters import HTTPAdapter
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    raise SystemExit("请先执行：py -m pip install requests cryptography")

VERSION="2026.08.03-python-downloader-v1"
ROOT_DEFAULT=Path(r"F:\tools\short_videos")
VIDEO_NAMES=("video.mp4","video.ts","video.webm","video.mkv")
COVER_NAMES=("cover.webp","cover.jpg","cover.jpeg","cover.png","cover.avif")
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36"
DEFAULTS={
 "pid":"PH","version":"1.2.75","token":"","token_env":"HQ_VIDEO_TOKEN",
 "api_bases":["https://d1n2abym1937a5.cloudfront.net/api/v1/","https://fall.faj135.com/api/v1/","https://gk.ifryz.cc/api/v1/"],
 "resource_bases":["https://d3jeuxj39y9yke.cloudfront.net/","https://kayley.hljxswl.com/","https://savannah.sxhlcwlb.com/"],
 "aes_key":"sFRUdDdCbu62vfSnrJaPedBRCyKyLu8m","image_aes_key":"82758dd12749c777ef579f1839ceea6a",
 "media_key_base64":"HscELgq8dVNfyKujQOGoaA==","video_workers":12,"segment_workers":96,
 "per_video_inflight":24,"connection_pool":192,"timeout":35,"retries":3,
 "watch_interval":60,"refresh_attempts":1,"verify_tls":True
}

class Retryable(RuntimeError): pass
class StopNow(RuntimeError): pass

def jread(p,default):
    try:return json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:return default

def jwrite(p,v):
    p.parent.mkdir(parents=True,exist_ok=True); t=p.with_suffix(p.suffix+".tmp")
    t.write_text(json.dumps(v,ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    os.replace(t,p)

def bwrite(p,b):
    p.parent.mkdir(parents=True,exist_ok=True); t=p.with_suffix(p.suffix+".tmp")
    t.write_bytes(b); os.replace(t,p)

def clean(s,n=56):
    s=re.sub(r'[\\/:*?"<>|\x00-\x1f]',"_",str(s or "")); s=re.sub(r"[. ]+$","",s)
    return (re.sub(r"\s+"," ",s).strip() or "未命名")[:n]

def uniq(xs):
    out=[]
    for x in xs:
        x=str(x or "").strip()
        if x and x not in out: out.append(x)
    return out

def arr(v,d=0):
    if d>8:return []
    if isinstance(v,list):return v
    if not isinstance(v,dict):return []
    for k in ("videoInfo","contents","videos","list","items","records","rows","data"):
        r=arr(v.get(k),d+1)
        if r:return r
    return []

def existing(d,names):
    for n in names:
        p=d/n
        if p.is_file() and p.stat().st_size>0:return p
    return None

def attrs(s):
    return {m.group(1).upper():m.group(2).strip().strip('"') for m in re.finditer(r'([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)',s,re.I)}

def iv_bytes(v,seq):
    return int(v[2:],16).to_bytes(16,"big")[-16:] if v and re.fullmatch(r"0x[0-9a-f]+",v,re.I) else int(seq).to_bytes(16,"big")

def decrypt_cbc(data,key,iv):
    dec=Cipher(algorithms.AES(key),modes.CBC(iv)).decryptor(); out=dec.update(data)+dec.finalize()
    try:u=padding.PKCS7(128).unpadder(); return u.update(out)+u.finalize()
    except ValueError:return out

def decrypt_ecb(data,key):
    dec=Cipher(algorithms.AES(key),modes.ECB()).decryptor(); out=dec.update(data)+dec.finalize()
    try:u=padding.PKCS7(128).unpadder(); return u.update(out)+u.finalize()
    except ValueError:return out.rstrip(b"\0")

def image_kind(b):
    if b.startswith(b"\xff\xd8\xff"):return "jpg"
    if b.startswith(b"\x89PNG\r\n\x1a\n"):return "png"
    if len(b)>12 and b[:4]==b"RIFF" and b[8:12]==b"WEBP":return "webp"
    if len(b)>12 and b[4:12].startswith(b"ftyp"):return "avif"
    return ""

def decode_image(b,key):
    k=image_kind(b)
    if k:return b,k
    if len(b)%16:raise RuntimeError("加密封面长度错误")
    b=decrypt_ecb(b,key.encode())
    k=image_kind(b)
    if k:return b,k
    with contextlib.suppress(Exception):
        s=b.decode().strip().rstrip("\0")
        if s.startswith("data:image/"):
            b=base64.b64decode(s.split(",",1)[1]); k=image_kind(b)
            if k:return b,k
        b2=base64.b64decode(s); k=image_kind(b2)
        if k:return b2,k
    raise RuntimeError("封面解密后仍无法识别")

def api_decrypt(body,key):
    if not isinstance(body,dict) or not isinstance(body.get("data"),str) or not body["data"]:return body
    raw=decrypt_ecb(base64.b64decode(body["data"]),key.encode())
    comp=base64.b64decode(raw.decode().strip())
    for w in (zlib.MAX_WBITS,-zlib.MAX_WBITS,zlib.MAX_WBITS|16):
        with contextlib.suppress(zlib.error):
            return {**body,"data":json.loads(zlib.decompress(comp,w).decode())}
    raise RuntimeError("API 数据解压失败")

def playable(v,d=0):
    if d>8:return ""
    if isinstance(v,str):return v if v.startswith("http") and ("m3u8" in v or "sign=" in v) else ""
    if isinstance(v,list):
        for x in v:
            r=playable(x,d+1)
            if r:return r
    if isinstance(v,dict):
        for k in ("url","playURL","playUrl","videoURL","videoUrl","m3u8URL","m3u8Url","signedPlaylistUrl","playlistUrl"):
            x=v.get(k)
            if isinstance(x,str) and x.startswith("http"):return x
        for x in v.values():
            r=playable(x,d+1)
            if r:return r
    return ""

def fmt(n):
    n=float(n)
    for u in ("B","KB","MB","GB","TB"):
        if abs(n)<1024 or u=="TB":return f"{n:.2f} {u}"
        n/=1024

def norm_work(x,i):
    w=x.get("video") if isinstance(x,dict) and isinstance(x.get("video"),dict) else (x if isinstance(x,dict) else {})
    vid=str(w.get("id") or w.get("videoId") or w.get("vid") or (x.get("id") if isinstance(x,dict) else "") or "")
    title=str(w.get("title") or w.get("name") or "")
    cover=str(w.get("coverPath") or w.get("verticalCoverURL") or w.get("coverURL") or w.get("coverUrl") or "")
    urls=uniq([(x.get("url") if isinstance(x,dict) else ""),w.get("url"),w.get("signedPlaylistUrl"),w.get("playPath"),w.get("playURL"),w.get("playUrl"),w.get("m3u8URL"),w.get("m3u8Url")])
    return {"id":vid,"index":int((x.get("index") if isinstance(x,dict) else 0) or w.get("index") or i),"title":title,"cover":cover,"urls":urls,"raw":x}

class Lock:
    def __init__(self,p):self.p=p
    def __enter__(self):
        self.f=self.p.open("a+b")
        try:
            if os.name=="nt":
                import msvcrt; self.f.seek(0); self.f.write(b"0"); self.f.flush(); self.f.seek(0); msvcrt.locking(self.f.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl; fcntl.flock(self.f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise SystemExit("已有下载程序正在运行")
        return self
    def __exit__(self,*_):self.f.close()
