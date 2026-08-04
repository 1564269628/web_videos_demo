(() => {
  const state={seed:sessionStorage.getItem('local-feed-seed')||String(Date.now()),offset:0,limit:18,loading:false,hasMore:true,activeIndex:-1,observer:null,items:new Map(),liked:new Set(),collected:new Set(),muted:localStorage.getItem('local-player-muted')!=='false',author:null,authorOffset:0};
  const $=(s,r=document)=>r.querySelector(s); const feed=$('#feed'); const toast=$('#toast');
  function showToast(text){toast.textContent=text;toast.hidden=false;clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.hidden=true,2400)}
  function fmtDuration(v){v=Math.max(0,Number(v||0));const h=Math.floor(v/3600),m=Math.floor(v%3600/60),s=Math.floor(v%60);return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`}
  async function api(path,options){const r=await fetch(path,options);if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);return r.json()}
  async function loadSummary(){const s=await api('/api/summary');$('#sidebar-stats').innerHTML=`作者 ${s.authorCount} 位<br>本地视频 ${s.videoCount} 条<br>${s.ffmpegAvailable?'FFmpeg 已就绪':'未检测到 FFmpeg'}<br><small>${s.root}</small>`}
  function action(icon,label,value,cls=''){return `<button class="${cls}" data-action="${label}"><span class="circle">${icon}</span><span>${value||''}</span></button>`}
  function createSlide(item){
    if(state.items.has(item.id))return state.items.get(item.id);
    const el=document.createElement('article');el.className='slide';el.dataset.id=item.id;el.innerHTML=`
      <img class="video-bg" src="${item.coverUrl}" alt="">
      <div class="video-stage"><video playsinline preload="metadata" poster="${item.coverUrl}" ${state.muted?'muted':''}></video><div class="tap-layer" aria-label="播放或暂停"></div><div class="play-state" hidden></div></div>
      <div class="overlay"></div><div class="meta"><button class="author-link">@${escapeHtml(item.author.name)}</button><div class="title">${escapeHtml(item.title)}</div><div class="tags">${item.tags.map(t=>'#'+escapeHtml(t)).join(' ')} ${item.duration?' · '+fmtDuration(item.duration):''}</div></div>
      <div class="rail"><button data-action="author"><img src="${item.author.avatarUrl}" alt="作者头像"></button>${action('♥','like',item.likeCountLabel)}${action('💬','comment',item.commentCountLabel)}${action('★','collect',item.collectCountLabel)}${action(state.muted?'🔇':'🔊','mute','')}</div>`;
    const video=$('video',el),status=$('.play-state',el);
    $('.tap-layer',el).addEventListener('click',()=>{video.paused?video.play().catch(()=>{}):video.pause()});
    $('.author-link',el).addEventListener('click',()=>openAuthor(item.author.id));
    $('[data-action="author"]',el).addEventListener('click',()=>openAuthor(item.author.id));
    $('[data-action="like"]',el).addEventListener('click',e=>toggleLocal(e.currentTarget,state.liked,item.id));
    $('[data-action="collect"]',el).addEventListener('click',e=>toggleLocal(e.currentTarget,state.collected,item.id));
    $('[data-action="comment"]',el).addEventListener('click',()=>showToast('本地归档没有保存评论正文'));
    $('[data-action="mute"]',el).addEventListener('click',()=>{state.muted=!state.muted;localStorage.setItem('local-player-muted',String(state.muted));document.querySelectorAll('video').forEach(v=>v.muted=state.muted);document.querySelectorAll('[data-action="mute"] .circle').forEach(n=>n.textContent=state.muted?'🔇':'🔊')});
    video.addEventListener('waiting',()=>showStatus(status,'正在缓冲…',true));video.addEventListener('playing',()=>status.hidden=true);video.addEventListener('error',()=>showStatus(status,'浏览器无法播放该文件，可安装 FFmpeg 后重新打开。',false));
    state.items.set(item.id,el);return el;
  }
  function toggleLocal(button,set,id){set.has(id)?set.delete(id):set.add(id);button.classList.toggle('active',set.has(id))}
  function showStatus(node,text,spin){node.innerHTML=`${spin?'<span class="spinner"></span>':''}${escapeHtml(text)}`;node.hidden=false}
  async function prepareVideo(el){
    if(el.dataset.prepared==='1')return;el.dataset.prepared='1';const id=el.dataset.id,video=$('video',el),status=$('.play-state',el);showStatus(status,'正在准备本地视频…',true);
    for(let tries=0;tries<180;tries++){
      const p=await api('/api/play?id='+encodeURIComponent(id));
      if(p.status==='ready'||p.status==='fallback'){video.src=p.url;video.muted=state.muted;video.load();status.hidden=true;video.play().catch(()=>{});if(p.message)showToast(p.message);return}
      if(p.status==='failed'){showStatus(status,p.message||'视频准备失败',false);if(p.fallbackUrl){video.src=p.fallbackUrl;video.load()}return}
      showStatus(status,p.message||'正在无损封装…',true);await new Promise(r=>setTimeout(r,1000));
    }
    showStatus(status,'视频准备超时',false);
  }
  function activate(index){
    const slides=[...document.querySelectorAll('.slide')];if(index<0||index>=slides.length)return;state.activeIndex=index;
    slides.forEach((s,i)=>{const v=$('video',s);if(i===index){prepareVideo(s).catch(e=>showStatus($('.play-state',s),e.message,false));if(v.src)v.play().catch(()=>{})}else{v.pause()}});
    if(index>=slides.length-5)loadMore();
  }
  function setupObserver(){state.observer?.disconnect();state.observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting&&e.intersectionRatio>.72){const slides=[...document.querySelectorAll('.slide')];activate(slides.indexOf(e.target))}},{root:feed,threshold:[.72]});document.querySelectorAll('.slide').forEach(s=>state.observer.observe(s))}
  async function loadMore(reset=false){if(state.loading||(!state.hasMore&&!reset))return;state.loading=true;try{if(reset){state.offset=0;state.hasMore=true;state.items.clear();feed.innerHTML=''}const data=await api(`/api/feed?seed=${encodeURIComponent(state.seed)}&offset=${state.offset}&limit=${state.limit}`);for(const item of data.items)feed.append(createSlide(item));state.offset+=data.items.length;state.hasMore=data.hasMore;setupObserver();if(reset&&data.items.length)feed.firstElementChild.scrollIntoView();if(!data.items&&reset)feed.innerHTML='<div class="empty">没有找到已下载的视频。</div>'}finally{state.loading=false}}
  function reshuffle(){state.seed=String(Date.now());sessionStorage.setItem('local-feed-seed',state.seed);loadMore(true).catch(e=>showToast(e.message))}
  async function rescan(){showToast('正在重新扫描目录…');await api('/api/rescan',{method:'POST'});await loadSummary();reshuffle()}
  async function openAuthor(id){state.author=id;state.authorOffset=0;const modal=$('#author-modal');modal.hidden=false;$('#works-grid').innerHTML='';await loadAuthor(true)}
  async function loadAuthor(reset=false){const data=await api(`/api/author?id=${encodeURIComponent(state.author)}&offset=${reset?0:state.authorOffset}&limit=80`);const a=data.author;$('#author-avatar').src=a.avatarUrl;$('#author-name').textContent=a.name;$('#author-uid').textContent='UID '+(a.uid||'—');$('#author-signature').textContent=a.signature||'暂无简介';$('#author-stats').innerHTML=`<span><strong>${a.downloadedCount}</strong>本地作品</span><span><strong>${a.followerCountLabel}</strong>粉丝</span><span><strong>${a.likedCountLabel}</strong>获赞</span><span><strong>${a.collectCountLabel}</strong>收藏</span>`;const grid=$('#works-grid');for(const item of data.items){const b=document.createElement('button');b.className='work-card';b.innerHTML=`<img loading="lazy" src="${item.coverUrl}" alt=""><div class="copy"><strong>${escapeHtml(item.title)}</strong><small>▶ ${item.playCountLabel}　♥ ${item.likeCountLabel}</small></div>`;b.addEventListener('click',()=>playFromAuthor(item));grid.append(b)}state.authorOffset=(reset?0:state.authorOffset)+data.items.length;$('#works-status').textContent=`${data.total} 个已下载作品`;if(data.hasMore){const more=document.createElement('button');more.className='pill';more.textContent='加载更多';more.addEventListener('click',()=>{more.remove();loadAuthor(false)});grid.append(more)}}
  function playFromAuthor(item){let el=state.items.get(item.id);if(!el){el=createSlide(item);feed.append(el);setupObserver()}$('#author-modal').hidden=true;el.scrollIntoView({behavior:'smooth'});setTimeout(()=>{const slides=[...document.querySelectorAll('.slide')];activate(slides.indexOf(el))},350)}
  function escapeHtml(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
  $('#shuffle').addEventListener('click',reshuffle);$('#shuffle-side').addEventListener('click',reshuffle);$('#rescan').addEventListener('click',rescan);$('#rescan-side').addEventListener('click',rescan);$('#author-close').addEventListener('click',()=>$('#author-modal').hidden=true);$('#author-modal').addEventListener('click',e=>{if(e.target.id==='author-modal')e.currentTarget.hidden=true});
  document.addEventListener('keydown',e=>{if(!$('#author-modal').hidden&&e.key==='Escape'){$('#author-modal').hidden=true;return}if(e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();const s=[...document.querySelectorAll('.slide')];s[Math.min(s.length-1,state.activeIndex+1)]?.scrollIntoView({behavior:'smooth'})}if(e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();const s=[...document.querySelectorAll('.slide')];s[Math.max(0,state.activeIndex-1)]?.scrollIntoView({behavior:'smooth'})}if(e.code==='Space'&&$('#author-modal').hidden){const s=[...document.querySelectorAll('.slide')][state.activeIndex],v=s&&$('video',s);if(v){e.preventDefault();v.paused?v.play().catch(()=>{}):v.pause()}}});
  Promise.all([loadSummary(),loadMore(true)]).catch(e=>{feed.innerHTML=`<div class="empty"><div><strong>启动失败</strong><p>${escapeHtml(e.message)}</p></div></div>`});
})();
