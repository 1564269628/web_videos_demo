(() => {
  const state={seed:sessionStorage.getItem('local-feed-seed')||String(Date.now()),offset:0,limit:18,loading:false,hasMore:true,activeIndex:-1,observer:null,items:new Map(),liked:new Set(),collected:new Set(),muted:localStorage.getItem('local-player-muted')!=='false',author:null,authorOffset:0};
  const $=(s,r=document)=>r.querySelector(s); const feed=$('#feed'); const toast=$('#toast');
  const sessionId=(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let logQueue=[]; let logTimer=0; let flushingLogs=false;

  function clientLog(event,details={}){
    logQueue.push({event,sessionId,page:location.href,time:new Date().toISOString(),...details});
    if(logQueue.length>=12)flushClientLogs();
    else if(!logTimer)logTimer=setTimeout(flushClientLogs,350);
  }
  async function flushClientLogs(useBeacon=false){
    clearTimeout(logTimer);logTimer=0;if(flushingLogs||!logQueue.length)return;
    const batch=logQueue.splice(0,100);const body=JSON.stringify(batch);
    if(useBeacon&&navigator.sendBeacon){navigator.sendBeacon('/api/client-log',new Blob([body],{type:'application/json'}));return}
    flushingLogs=true;
    try{await fetch('/api/client-log',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true})}
    catch{logQueue.unshift(...batch.slice(-30))}
    finally{flushingLogs=false;if(logQueue.length&&!logTimer)logTimer=setTimeout(flushClientLogs,800)}
  }
  window.addEventListener('pagehide',()=>flushClientLogs(true));
  window.addEventListener('error',event=>clientLog('window_error',{message:event.message,filename:event.filename,line:event.lineno,column:event.colno,stack:event.error?.stack}));
  window.addEventListener('unhandledrejection',event=>clientLog('unhandled_rejection',{reason:String(event.reason),stack:event.reason?.stack}));

  function showToast(text){toast.textContent=text;toast.hidden=false;clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.hidden=true,3500)}
  function fmtDuration(v){v=Math.max(0,Number(v||0));const h=Math.floor(v/3600),m=Math.floor(v%3600/60),s=Math.floor(v%60);return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`}
  async function api(path,options){
    const started=performance.now();
    try{
      const r=await fetch(path,options);const text=await r.text();let data={};
      try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,1000)}}
      clientLog('api_response',{path,status:r.status,ok:r.ok,elapsedMs:Math.round(performance.now()-started),response:data});
      if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;
    }catch(error){clientLog('api_error',{path,message:error.message,stack:error.stack,elapsedMs:Math.round(performance.now()-started)});throw error}
  }
  async function loadSummary(){
    const s=await api('/api/summary');
    $('#sidebar-stats').innerHTML=`作者 ${s.authorCount} 位<br>本地视频 ${s.videoCount} 条<br>${s.ffmpegAvailable?'FFmpeg 已就绪':'未检测到 FFmpeg'}<br>${s.ffprobeAvailable?'FFprobe 已就绪':'未检测到 FFprobe'}<br><small title="${escapeHtml(s.logDir||'')}">日志：${escapeHtml(s.logDir||'未启用')}</small><br><small>${escapeHtml(s.root)}</small>`;
    clientLog('summary_loaded',{summary:s,userAgent:navigator.userAgent});
  }
  function action(icon,label,value,cls=''){return `<button class="${cls}" data-action="${label}"><span class="circle">${icon}</span><span>${value||''}</span></button>`}
  function mediaErrorDetails(video){
    const error=video.error;const names={1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'};
    return {code:error?.code||0,name:names[error?.code]||'NONE',message:error?.message||'',networkState:video.networkState,readyState:video.readyState,currentSrc:video.currentSrc,src:video.getAttribute('src'),currentTime:Number.isFinite(video.currentTime)?video.currentTime:null,duration:Number.isFinite(video.duration)?video.duration:null,videoWidth:video.videoWidth,videoHeight:video.videoHeight,paused:video.paused,muted:video.muted,volume:video.volume};
  }
  function bindVideoDiagnostics(video,item,status,el){
    const events=['loadstart','durationchange','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing','pause','waiting','stalled','suspend','abort','emptied','ended','error'];
    for(const eventName of events){
      video.addEventListener(eventName,()=>{
        const details={workId:item.id,title:item.title,eventName,...mediaErrorDetails(video)};
        clientLog(`video_${eventName}`,details);
        if(eventName==='waiting'||eventName==='stalled')showStatus(status,eventName==='waiting'?'正在缓冲…':'视频加载停滞，正在记录诊断日志…',true);
        if(eventName==='playing')status.hidden=true;
        if(eventName==='error'){
          el.dataset.prepared='0';
          const d=mediaErrorDetails(video);
          showStatus(status,`播放失败：${d.name}${d.message?' · '+d.message:''}\n诊断编号：${item.id}`,false);
          showToast('详细错误已写入 browser.log 和 media.log');
        }
      });
    }
  }
  function createSlide(item){
    if(state.items.has(item.id))return state.items.get(item.id);
    const el=document.createElement('article');el.className='slide';el.dataset.id=item.id;el.innerHTML=`
      <img class="video-bg" src="${item.coverUrl}" alt="">
      <div class="video-stage"><video playsinline preload="metadata" poster="${item.coverUrl}" ${state.muted?'muted':''}></video><div class="tap-layer" aria-label="播放或暂停"></div><div class="play-state" hidden></div></div>
      <div class="overlay"></div><div class="meta"><button class="author-link">@${escapeHtml(item.author.name)}</button><div class="title">${escapeHtml(item.title)}</div><div class="tags">${item.tags.map(t=>'#'+escapeHtml(t)).join(' ')} ${item.duration?' · '+fmtDuration(item.duration):''}</div></div>
      <div class="rail"><button data-action="author"><img src="${item.author.avatarUrl}" alt="作者头像"></button>${action('♥','like',item.likeCountLabel)}${action('💬','comment',item.commentCountLabel)}${action('★','collect',item.collectCountLabel)}${action(state.muted?'🔇':'🔊','mute','')}</div>`;
    const video=$('video',el),status=$('.play-state',el);bindVideoDiagnostics(video,item,status,el);
    $('.tap-layer',el).addEventListener('click',async()=>{
      clientLog('video_tap',{workId:item.id,...mediaErrorDetails(video)});
      if(video.error||!video.currentSrc){el.dataset.prepared='0';await prepareVideo(el);return}
      if(video.paused)await tryPlay(video,item,status);else video.pause();
    });
    $('.author-link',el).addEventListener('click',()=>openAuthor(item.author.id));
    $('[data-action="author"]',el).addEventListener('click',()=>openAuthor(item.author.id));
    $('[data-action="like"]',el).addEventListener('click',e=>toggleLocal(e.currentTarget,state.liked,item.id));
    $('[data-action="collect"]',el).addEventListener('click',e=>toggleLocal(e.currentTarget,state.collected,item.id));
    $('[data-action="comment"]',el).addEventListener('click',()=>showToast('本地归档没有保存评论正文'));
    $('[data-action="mute"]',el).addEventListener('click',()=>{
      state.muted=!state.muted;localStorage.setItem('local-player-muted',String(state.muted));document.querySelectorAll('video').forEach(v=>v.muted=state.muted);document.querySelectorAll('[data-action="mute"] .circle').forEach(n=>n.textContent=state.muted?'🔇':'🔊');clientLog('mute_changed',{muted:state.muted});
    });
    state.items.set(item.id,el);return el;
  }
  function toggleLocal(button,set,id){set.has(id)?set.delete(id):set.add(id);button.classList.toggle('active',set.has(id))}
  function showStatus(node,text,spin){node.innerHTML=`${spin?'<span class="spinner"></span>':''}${escapeHtml(text).replace(/\n/g,'<br>')}`;node.hidden=false}
  async function tryPlay(video,item,status){
    try{
      await video.play();clientLog('play_promise_resolved',{workId:item.id,...mediaErrorDetails(video)});return true;
    }catch(error){
      clientLog('play_promise_rejected',{workId:item.id,errorName:error.name,message:error.message,stack:error.stack,...mediaErrorDetails(video)});
      if(error.name==='NotAllowedError'&&!video.muted){
        state.muted=true;video.muted=true;localStorage.setItem('local-player-muted','true');document.querySelectorAll('[data-action="mute"] .circle').forEach(n=>n.textContent='🔇');
        try{await video.play();showToast('浏览器阻止了有声自动播放，已自动静音');clientLog('play_retry_muted_resolved',{workId:item.id});return true}catch(retryError){clientLog('play_retry_muted_rejected',{workId:item.id,errorName:retryError.name,message:retryError.message})}
      }
      showStatus(status,`浏览器拒绝播放：${error.name} · ${error.message}\n诊断编号：${item.id}`,false);return false;
    }
  }
  async function prepareVideo(el){
    if(el.dataset.prepared==='1')return;el.dataset.prepared='1';const id=el.dataset.id,video=$('video',el),status=$('.play-state',el);showStatus(status,'正在准备本地视频…',true);clientLog('prepare_started',{workId:id});
    try{
      for(let tries=0;tries<180;tries++){
        const p=await api('/api/play?id='+encodeURIComponent(id));
        clientLog('play_status',{workId:id,tries,status:p.status,payload:p});
        if(p.status==='ready'){
          video.pause();video.removeAttribute('src');video.load();video.src=p.url;video.muted=state.muted;video.load();
          showStatus(status,p.warning||'视频已准备，正在启动播放…',true);
          clientLog('video_source_assigned',{workId:id,url:p.url,mime:p.mime,bytes:p.bytes,probe:p.probe,warning:p.warning});
          await tryPlay(video,{id},status);if(p.warning)showToast(p.warning);return;
        }
        if(p.status==='failed'){
          el.dataset.prepared='0';showStatus(status,`${p.message||'视频准备失败'}\n诊断编号：${id}`,false);clientLog('prepare_failed',{workId:id,payload:p});return;
        }
        showStatus(status,p.message||'正在无损封装…',true);await new Promise(r=>setTimeout(r,1000));
      }
      el.dataset.prepared='0';showStatus(status,`视频准备超时\n诊断编号：${id}`,false);clientLog('prepare_timeout',{workId:id});
    }catch(error){el.dataset.prepared='0';showStatus(status,`${error.message}\n诊断编号：${id}`,false);clientLog('prepare_exception',{workId:id,message:error.message,stack:error.stack});throw error}
  }
  function activate(index){
    const slides=[...document.querySelectorAll('.slide')];if(index<0||index>=slides.length)return;state.activeIndex=index;clientLog('slide_activated',{index,workId:slides[index]?.dataset.id});
    slides.forEach((s,i)=>{const v=$('video',s);if(i===index){prepareVideo(s).catch(e=>showStatus($('.play-state',s),e.message,false));if(v.src)tryPlay(v,{id:s.dataset.id},$('.play-state',s))}else{v.pause()}});
    if(index>=slides.length-5)loadMore();
  }
  function setupObserver(){state.observer?.disconnect();state.observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting&&e.intersectionRatio>.72){const slides=[...document.querySelectorAll('.slide')];activate(slides.indexOf(e.target))}},{root:feed,threshold:[.72]});document.querySelectorAll('.slide').forEach(s=>state.observer.observe(s))}
  async function loadMore(reset=false){if(state.loading||(!state.hasMore&&!reset))return;state.loading=true;try{if(reset){state.offset=0;state.hasMore=true;state.items.clear();feed.innerHTML=''}const data=await api(`/api/feed?seed=${encodeURIComponent(state.seed)}&offset=${state.offset}&limit=${state.limit}`);for(const item of data.items)feed.append(createSlide(item));state.offset+=data.items.length;state.hasMore=data.hasMore;setupObserver();if(reset&&data.items.length)feed.firstElementChild.scrollIntoView();if(!data.items&&reset)feed.innerHTML='<div class="empty">没有找到已下载的视频。</div>';clientLog('feed_loaded',{reset,count:data.items.length,offset:state.offset,total:data.total})}finally{state.loading=false}}
  function reshuffle(){state.seed=String(Date.now());sessionStorage.setItem('local-feed-seed',state.seed);clientLog('feed_reshuffled',{seed:state.seed});loadMore(true).catch(e=>showToast(e.message))}
  async function rescan(){showToast('正在重新扫描目录…');await api('/api/rescan',{method:'POST'});await loadSummary();reshuffle()}
  async function openAuthor(id){state.author=id;state.authorOffset=0;const modal=$('#author-modal');modal.hidden=false;$('#works-grid').innerHTML='';await loadAuthor(true)}
  async function loadAuthor(reset=false){const data=await api(`/api/author?id=${encodeURIComponent(state.author)}&offset=${reset?0:state.authorOffset}&limit=80`);const a=data.author;$('#author-avatar').src=a.avatarUrl;$('#author-name').textContent=a.name;$('#author-uid').textContent='UID '+(a.uid||'—');$('#author-signature').textContent=a.signature||'暂无简介';$('#author-stats').innerHTML=`<span><strong>${a.downloadedCount}</strong>本地作品</span><span><strong>${a.followerCountLabel}</strong>粉丝</span><span><strong>${a.likedCountLabel}</strong>获赞</span><span><strong>${a.collectCountLabel}</strong>收藏</span>`;const grid=$('#works-grid');for(const item of data.items){const b=document.createElement('button');b.className='work-card';b.innerHTML=`<img loading="lazy" src="${item.coverUrl}" alt=""><div class="copy"><strong>${escapeHtml(item.title)}</strong><small>▶ ${item.playCountLabel}　♥ ${item.likeCountLabel}</small></div>`;b.addEventListener('click',()=>playFromAuthor(item));grid.append(b)}state.authorOffset=(reset?0:state.authorOffset)+data.items.length;$('#works-status').textContent=`${data.total} 个已下载作品`;if(data.hasMore){const more=document.createElement('button');more.className='pill';more.textContent='加载更多';more.addEventListener('click',()=>{more.remove();loadAuthor(false)});grid.append(more)}}
  function playFromAuthor(item){let el=state.items.get(item.id);if(!el){el=createSlide(item);feed.append(el);setupObserver()}$('#author-modal').hidden=true;el.scrollIntoView({behavior:'smooth'});setTimeout(()=>{const slides=[...document.querySelectorAll('.slide')];activate(slides.indexOf(el))},350)}
  function escapeHtml(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
  $('#shuffle').addEventListener('click',reshuffle);$('#shuffle-side').addEventListener('click',reshuffle);$('#rescan').addEventListener('click',rescan);$('#rescan-side').addEventListener('click',rescan);$('#author-close').addEventListener('click',()=>$('#author-modal').hidden=true);$('#author-modal').addEventListener('click',e=>{if(e.target.id==='author-modal')e.currentTarget.hidden=true});
  document.addEventListener('keydown',e=>{if(!$('#author-modal').hidden&&e.key==='Escape'){$('#author-modal').hidden=true;return}if(e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();const s=[...document.querySelectorAll('.slide')];s[Math.min(s.length-1,state.activeIndex+1)]?.scrollIntoView({behavior:'smooth'})}if(e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();const s=[...document.querySelectorAll('.slide')];s[Math.max(0,state.activeIndex-1)]?.scrollIntoView({behavior:'smooth'})}if(e.code==='Space'&&$('#author-modal').hidden){const s=[...document.querySelectorAll('.slide')][state.activeIndex],v=s&&$('video',s);if(v){e.preventDefault();v.paused?tryPlay(v,{id:s.dataset.id},$('.play-state',s)):v.pause()}}});
  clientLog('page_initialized',{sessionId,userAgent:navigator.userAgent,muted:state.muted,language:navigator.language,hardwareConcurrency:navigator.hardwareConcurrency});
  Promise.all([loadSummary(),loadMore(true)]).catch(e=>{feed.innerHTML=`<div class="empty"><div><strong>启动失败</strong><p>${escapeHtml(e.message)}</p></div></div>`;clientLog('startup_failed',{message:e.message,stack:e.stack})});
})();
