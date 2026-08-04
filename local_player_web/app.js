(() => {
  const state = {
    seed: sessionStorage.getItem('local-feed-seed') || String(Date.now()),
    offset: 0,
    limit: 18,
    loading: false,
    hasMore: true,
    activeIndex: -1,
    observer: null,
    items: new Map(),
    liked: new Set(),
    collected: new Set(),
    muted: localStorage.getItem('local-player-muted') !== 'false',
    author: null,
    authorOffset: 0,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const feed = $('#feed');
  const toast = $('#toast');
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let logQueue = [];
  let logTimer = 0;
  let flushingLogs = false;

  function clientLog(event, details = {}) {
    logQueue.push({ event, sessionId, page: location.href, time: new Date().toISOString(), ...details });
    if (logQueue.length >= 12) flushClientLogs();
    else if (!logTimer) logTimer = setTimeout(flushClientLogs, 350);
  }

  async function flushClientLogs(useBeacon = false) {
    clearTimeout(logTimer);
    logTimer = 0;
    if (flushingLogs || !logQueue.length) return;
    const batch = logQueue.splice(0, 100);
    const body = JSON.stringify(batch);
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
      return;
    }
    flushingLogs = true;
    try {
      await fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch {
      logQueue.unshift(...batch.slice(-30));
    } finally {
      flushingLogs = false;
      if (logQueue.length && !logTimer) logTimer = setTimeout(flushClientLogs, 800);
    }
  }

  window.addEventListener('pagehide', () => flushClientLogs(true));
  window.addEventListener('error', (event) => clientLog('window_error', {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack,
  }));
  window.addEventListener('unhandledrejection', (event) => clientLog('unhandled_rejection', {
    reason: String(event.reason),
    stack: event.reason?.stack,
  }));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[char]));
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  function fmtDuration(value, empty = '--:--') {
    const total = Number(value);
    if (!Number.isFinite(total) || total < 0) return empty;
    const seconds = Math.floor(total % 60);
    const minutes = Math.floor((total / 60) % 60);
    const hours = Math.floor(total / 3600);
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  async function api(path, options) {
    const started = performance.now();
    try {
      const response = await fetch(path, options);
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
      clientLog('api_response', {
        path,
        status: response.status,
        ok: response.ok,
        elapsedMs: Math.round(performance.now() - started),
      });
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      clientLog('api_error', { path, message: error.message, stack: error.stack });
      throw error;
    }
  }

  async function loadSummary() {
    const summary = await api('/api/summary');
    const limitText = summary.scanLimit > 0
      ? `扫描上限 ${summary.scanLimit} 条${summary.scanLimitReached ? '（已达到）' : ''}`
      : '扫描全部视频';
    $('#sidebar-stats').innerHTML = [
      `作者 ${summary.authorCount} 位`,
      `本地视频 ${summary.videoCount} 条`,
      limitText,
      summary.ffmpegAvailable ? 'FFmpeg 已就绪' : '未检测到 FFmpeg',
      `<small>${escapeHtml(summary.root)}</small>`,
    ].join('<br>');
    clientLog('summary_loaded', { summary, userAgent: navigator.userAgent });
  }

  function action(icon, label, value, className = '') {
    return `<button type="button" class="${className}" data-action="${label}"><span class="circle">${icon}</span><span>${value || ''}</span></button>`;
  }

  function mediaErrorDetails(video) {
    const error = video.error;
    const names = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
    return {
      code: error?.code || 0,
      name: names[error?.code] || 'NONE',
      message: error?.message || '',
      networkState: video.networkState,
      readyState: video.readyState,
      currentSrc: video.currentSrc,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      paused: video.paused,
      muted: video.muted,
    };
  }

  function showStatus(node, text, spin) {
    node.innerHTML = `${spin ? '<span class="spinner"></span>' : ''}${escapeHtml(text).replace(/\n/g, '<br>')}`;
    node.hidden = false;
  }

  function bindProgress(video, slide, item) {
    const control = $('.progress-control', slide);
    const range = $('input[type="range"]', control);
    const current = $('.progress-current', control);
    const duration = $('.progress-duration', control);
    let dragging = false;

    const render = () => {
      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number(item.duration || 0);
      if (!dragging && total > 0) range.value = String(Math.round((video.currentTime / total) * 1000));
      current.textContent = fmtDuration(video.currentTime, '0:00');
      duration.textContent = fmtDuration(total);
      range.disabled = !(total > 0);
      const percent = total > 0 ? Math.max(0, Math.min(100, (video.currentTime / total) * 100)) : 0;
      range.style.setProperty('--progress', `${percent}%`);
    };

    const seekFromRange = () => {
      const total = video.duration;
      if (!Number.isFinite(total) || total <= 0) return;
      const target = (Number(range.value) / 1000) * total;
      if (Number.isFinite(target)) video.currentTime = Math.max(0, Math.min(total, target));
      current.textContent = fmtDuration(target, '0:00');
      range.style.setProperty('--progress', `${Number(range.value) / 10}%`);
    };

    for (const eventName of ['pointerdown', 'touchstart', 'mousedown', 'click']) {
      control.addEventListener(eventName, (event) => event.stopPropagation(), { passive: eventName === 'touchstart' });
    }
    range.addEventListener('pointerdown', () => { dragging = true; });
    range.addEventListener('input', seekFromRange);
    range.addEventListener('change', () => {
      seekFromRange();
      dragging = false;
      clientLog('video_seek', { workId: item.id, currentTime: video.currentTime, duration: video.duration });
    });
    range.addEventListener('pointerup', () => { dragging = false; render(); });
    range.addEventListener('pointercancel', () => { dragging = false; render(); });
    video.addEventListener('timeupdate', render);
    video.addEventListener('durationchange', render);
    video.addEventListener('loadedmetadata', render);
    video.addEventListener('emptied', render);
    render();
  }

  function bindVideoDiagnostics(video, item, status, slide) {
    const events = ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'ended', 'error'];
    for (const eventName of events) {
      video.addEventListener(eventName, () => {
        clientLog(`video_${eventName}`, { workId: item.id, title: item.title, ...mediaErrorDetails(video) });
        if (eventName === 'waiting' || eventName === 'stalled') {
          showStatus(status, eventName === 'waiting' ? '正在缓冲…' : '视频加载停滞，正在记录日志…', true);
        }
        if (eventName === 'playing') status.hidden = true;
        if (eventName === 'error') {
          slide.dataset.prepared = '0';
          const details = mediaErrorDetails(video);
          showStatus(status, `播放失败：${details.name}${details.message ? ` · ${details.message}` : ''}\n诊断编号：${item.id}`, false);
        }
      });
    }
  }

  function createSlide(item) {
    if (state.items.has(item.id)) return state.items.get(item.id);
    const slide = document.createElement('article');
    slide.className = 'slide';
    slide.dataset.id = item.id;
    slide.innerHTML = `
      <img class="video-bg" src="${item.coverUrl}" alt="">
      <div class="video-stage">
        <video playsinline preload="metadata" poster="${item.coverUrl}" ${state.muted ? 'muted' : ''}></video>
        <div class="tap-layer" aria-label="播放或暂停"></div>
        <div class="play-state" hidden></div>
        <div class="progress-control" aria-label="视频进度控制">
          <span class="progress-current">0:00</span>
          <input type="range" min="0" max="1000" step="1" value="0" disabled aria-label="拖动视频进度">
          <span class="progress-duration">--:--</span>
        </div>
      </div>
      <div class="overlay"></div>
      <div class="meta">
        <button type="button" class="author-link">@${escapeHtml(item.author.name)}</button>
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="tags">${(item.tags || []).map((tag) => `#${escapeHtml(tag)}`).join(' ')} ${item.duration ? ` · ${fmtDuration(item.duration)}` : ''}</div>
      </div>
      <div class="rail">
        <button type="button" data-action="author"><img src="${item.author.avatarUrl}" alt="作者头像"></button>
        ${action('♥', 'like', item.likeCountLabel)}
        ${action('💬', 'comment', item.commentCountLabel)}
        ${action('★', 'collect', item.collectCountLabel)}
        ${action(state.muted ? '🔇' : '🔊', 'mute', '')}
      </div>`;

    const video = $('video', slide);
    const status = $('.play-state', slide);
    bindVideoDiagnostics(video, item, status, slide);
    bindProgress(video, slide, item);

    $('.tap-layer', slide).addEventListener('click', async () => {
      if (video.error || !video.currentSrc) {
        slide.dataset.prepared = '0';
        await prepareVideo(slide);
        return;
      }
      if (video.paused) await tryPlay(video, item, status);
      else video.pause();
    });
    $('.author-link', slide).addEventListener('click', () => openAuthor(item.author.id));
    $('[data-action="author"]', slide).addEventListener('click', () => openAuthor(item.author.id));
    $('[data-action="like"]', slide).addEventListener('click', (event) => toggleLocal(event.currentTarget, state.liked, item.id));
    $('[data-action="collect"]', slide).addEventListener('click', (event) => toggleLocal(event.currentTarget, state.collected, item.id));
    $('[data-action="comment"]', slide).addEventListener('click', () => showToast('本地归档没有保存评论正文'));
    $('[data-action="mute"]', slide).addEventListener('click', () => {
      state.muted = !state.muted;
      localStorage.setItem('local-player-muted', String(state.muted));
      document.querySelectorAll('video').forEach((element) => { element.muted = state.muted; });
      document.querySelectorAll('[data-action="mute"] .circle').forEach((node) => { node.textContent = state.muted ? '🔇' : '🔊'; });
    });

    state.items.set(item.id, slide);
    return slide;
  }

  function toggleLocal(button, set, id) {
    if (set.has(id)) set.delete(id); else set.add(id);
    button.classList.toggle('active', set.has(id));
  }

  async function tryPlay(video, item, status) {
    try {
      await video.play();
      return true;
    } catch (error) {
      clientLog('play_promise_rejected', { workId: item.id, errorName: error.name, message: error.message, ...mediaErrorDetails(video) });
      if (error.name === 'NotAllowedError' && !video.muted) {
        state.muted = true;
        video.muted = true;
        localStorage.setItem('local-player-muted', 'true');
        document.querySelectorAll('[data-action="mute"] .circle').forEach((node) => { node.textContent = '🔇'; });
        try {
          await video.play();
          showToast('浏览器阻止了有声自动播放，已自动静音');
          return true;
        } catch (retryError) {
          clientLog('play_retry_muted_rejected', { workId: item.id, errorName: retryError.name, message: retryError.message });
        }
      }
      showStatus(status, `浏览器拒绝播放：${error.name} · ${error.message}\n诊断编号：${item.id}`, false);
      return false;
    }
  }

  async function prepareVideo(slide) {
    if (slide.dataset.prepared === '1') return;
    slide.dataset.prepared = '1';
    const id = slide.dataset.id;
    const video = $('video', slide);
    const status = $('.play-state', slide);
    showStatus(status, '正在准备本地视频…', true);
    try {
      for (let tries = 0; tries < 180; tries += 1) {
        const payload = await api(`/api/play?id=${encodeURIComponent(id)}`);
        if (payload.status === 'ready') {
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.src = payload.url;
          video.muted = state.muted;
          video.load();
          showStatus(status, payload.warning || '视频已准备，正在启动播放…', true);
          await tryPlay(video, { id }, status);
          if (payload.warning) showToast(payload.warning);
          return;
        }
        if (payload.status === 'failed') {
          slide.dataset.prepared = '0';
          showStatus(status, `${payload.message || '视频准备失败'}\n诊断编号：${id}`, false);
          return;
        }
        showStatus(status, payload.message || '正在无损封装…', true);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      slide.dataset.prepared = '0';
      showStatus(status, `视频准备超时\n诊断编号：${id}`, false);
    } catch (error) {
      slide.dataset.prepared = '0';
      showStatus(status, `${error.message}\n诊断编号：${id}`, false);
      throw error;
    }
  }

  function activate(index) {
    const slides = [...document.querySelectorAll('.slide')];
    if (index < 0 || index >= slides.length) return;
    state.activeIndex = index;
    slides.forEach((slide, position) => {
      const video = $('video', slide);
      if (position === index) {
        prepareVideo(slide).catch((error) => showStatus($('.play-state', slide), error.message, false));
        if (video.src) tryPlay(video, { id: slide.dataset.id }, $('.play-state', slide));
      } else {
        video.pause();
      }
    });
    if (index >= slides.length - 5) loadMore();
  }

  function setupObserver() {
    state.observer?.disconnect();
    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.72) {
          const slides = [...document.querySelectorAll('.slide')];
          activate(slides.indexOf(entry.target));
        }
      }
    }, { root: feed, threshold: [0.72] });
    document.querySelectorAll('.slide').forEach((slide) => state.observer.observe(slide));
  }

  async function loadMore(reset = false) {
    if (state.loading || (!state.hasMore && !reset)) return;
    state.loading = true;
    try {
      if (reset) {
        state.offset = 0;
        state.hasMore = true;
        state.items.clear();
        feed.innerHTML = '';
      }
      const data = await api(`/api/feed?seed=${encodeURIComponent(state.seed)}&offset=${state.offset}&limit=${state.limit}`);
      for (const item of data.items || []) feed.append(createSlide(item));
      state.offset += (data.items || []).length;
      state.hasMore = Boolean(data.hasMore);
      setupObserver();
      if (reset && data.items?.length) feed.firstElementChild.scrollIntoView();
      if (!data.items?.length && reset) feed.innerHTML = '<div class="empty">没有找到已下载的视频。</div>';
    } finally {
      state.loading = false;
    }
  }

  function reshuffle() {
    state.seed = String(Date.now());
    sessionStorage.setItem('local-feed-seed', state.seed);
    loadMore(true).catch((error) => showToast(error.message));
  }

  async function rescan() {
    showToast('正在重新扫描目录，最多读取 50 个视频…');
    await api('/api/rescan', { method: 'POST' });
    await loadSummary();
    reshuffle();
  }

  function renderAuthorMessage(text, isError = false) {
    const grid = $('#works-grid');
    grid.innerHTML = `<div class="works-message${isError ? ' error' : ''}">${escapeHtml(text)}</div>`;
  }

  async function openAuthor(id) {
    state.author = id;
    state.authorOffset = 0;
    const modal = $('#author-modal');
    modal.hidden = false;
    document.body.classList.add('author-open');
    $('#author-name').textContent = '正在读取作者…';
    $('#author-uid').textContent = '';
    $('#author-signature').textContent = '';
    $('#author-stats').innerHTML = '';
    $('#works-status').textContent = '加载中…';
    renderAuthorMessage('正在读取本地作品…');
    const activeVideo = document.querySelectorAll('.slide')[state.activeIndex]?.querySelector('video');
    activeVideo?.pause();
    try {
      await loadAuthor(true);
    } catch (error) {
      $('#works-status').textContent = '加载失败';
      renderAuthorMessage(`作者作品加载失败：${error.message}`, true);
      clientLog('author_load_failed', { authorId: id, message: error.message, stack: error.stack });
    }
  }

  function closeAuthor() {
    $('#author-modal').hidden = true;
    document.body.classList.remove('author-open');
    const active = document.querySelectorAll('.slide')[state.activeIndex];
    if (active) tryPlay($('video', active), { id: active.dataset.id }, $('.play-state', active));
  }

  async function loadAuthor(reset = false) {
    const offset = reset ? 0 : state.authorOffset;
    const data = await api(`/api/author?id=${encodeURIComponent(state.author)}&offset=${offset}&limit=80`);
    const author = data.author;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!author) throw new Error('接口没有返回作者资料');

    $('#author-avatar').src = author.avatarUrl;
    $('#author-name').textContent = author.name || '未命名作者';
    $('#author-uid').textContent = `UID ${author.uid || '—'}`;
    $('#author-signature').textContent = author.signature || '暂无简介';
    $('#author-stats').innerHTML = `
      <span><strong>${author.downloadedCount}</strong>本地作品</span>
      <span><strong>${author.followerCountLabel}</strong>粉丝</span>
      <span><strong>${author.likedCountLabel}</strong>获赞</span>
      <span><strong>${author.collectCountLabel}</strong>收藏</span>`;

    const grid = $('#works-grid');
    if (reset) grid.replaceChildren();
    for (const item of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'work-card';
      card.innerHTML = `
        <div class="work-cover">
          <img src="${item.coverUrl}" alt="${escapeHtml(item.title)}">
          <span class="work-play">▶ ${item.playCountLabel || '0'}</span>
          ${item.duration ? `<span class="work-duration">${fmtDuration(item.duration)}</span>` : ''}
        </div>
        <div class="copy">
          <strong>${escapeHtml(item.title || '未命名作品')}</strong>
          <small>♥ ${item.likeCountLabel || '0'}</small>
        </div>`;
      card.addEventListener('click', () => playFromAuthor(item));
      grid.append(card);
    }

    state.authorOffset = offset + items.length;
    $('#works-status').textContent = `${data.total ?? items.length} 个已扫描作品`;
    if (!grid.children.length) {
      renderAuthorMessage(data.scanLimitReached
        ? '本次只扫描了前 50 个视频，没有找到该作者的更多作品。'
        : '没有找到该作者已下载到本地的作品。');
    }
    if (data.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pill works-more';
      more.textContent = '加载更多';
      more.addEventListener('click', async () => {
        more.disabled = true;
        more.textContent = '加载中…';
        try { more.remove(); await loadAuthor(false); }
        catch (error) { showToast(error.message); more.disabled = false; more.textContent = '重试'; }
      });
      grid.append(more);
    }
    if (reset) grid.scrollTop = 0;
    clientLog('author_loaded', { authorId: state.author, total: data.total, returned: items.length });
  }

  function playFromAuthor(item) {
    let slide = state.items.get(item.id);
    if (!slide) {
      slide = createSlide(item);
      feed.append(slide);
      setupObserver();
    }
    closeAuthor();
    slide.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => {
      const slides = [...document.querySelectorAll('.slide')];
      activate(slides.indexOf(slide));
    }, 350);
  }

  $('#shuffle').addEventListener('click', reshuffle);
  $('#shuffle-side').addEventListener('click', reshuffle);
  $('#rescan').addEventListener('click', rescan);
  $('#rescan-side').addEventListener('click', rescan);
  $('#author-close').addEventListener('click', closeAuthor);
  $('#author-modal').addEventListener('click', (event) => { if (event.target.id === 'author-modal') closeAuthor(); });

  document.addEventListener('keydown', (event) => {
    if (!$('#author-modal').hidden && event.key === 'Escape') { closeAuthor(); return; }
    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      const slides = [...document.querySelectorAll('.slide')];
      slides[Math.min(slides.length - 1, state.activeIndex + 1)]?.scrollIntoView({ behavior: 'smooth' });
    }
    if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      const slides = [...document.querySelectorAll('.slide')];
      slides[Math.max(0, state.activeIndex - 1)]?.scrollIntoView({ behavior: 'smooth' });
    }
    if (event.code === 'Space' && $('#author-modal').hidden) {
      const slide = [...document.querySelectorAll('.slide')][state.activeIndex];
      const video = slide && $('video', slide);
      if (video) {
        event.preventDefault();
        if (video.paused) tryPlay(video, { id: slide.dataset.id }, $('.play-state', slide));
        else video.pause();
      }
    }
  });

  clientLog('page_initialized', { userAgent: navigator.userAgent, muted: state.muted, language: navigator.language });
  Promise.all([loadSummary(), loadMore(true)]).catch((error) => {
    feed.innerHTML = `<div class="empty"><div><strong>启动失败</strong><p>${escapeHtml(error.message)}</p></div></div>`;
  });
})();
