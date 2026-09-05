/* ===== SapiX 国語（デイリーサピックス / Weekly SapiX / 志望校別特訓）=====
 * UIは理科v2/社会v2のwsm方式（デイリーサポート方式）に統一:
 *   単元カード → 即・問題ページ（問題/解答タブ + 常時表示の正誤表 + 印刷）
 * ○×は1回記録のトグル（従来どおり localStorage kokugo-ws-grade:<id> + GAS同期） */
'use strict';

const state = {
  units: [],        // units.json
  unitCache: {},    // id -> unit.json
  category: null,   // 現在のカテゴリ
  current: null,    // 現在表示中の unit.json
  showingAnswer: false,
};

const $ = (sel) => document.querySelector(sel);

// ---- カテゴリ定義（units.json のフィールドから振り分け）----
const CATEGORIES = [
  { id: 'daily',  name: 'デイリーサピックス', icon: '📚',
    match: (u) => u.category === 'daily-knowledge' },
  { id: 'weekly', name: 'Weekly SapiX', icon: '📖',
    match: (u) => u.category !== 'daily-knowledge' && !String(u.week).startsWith('志望校別特訓') },
  { id: 'shibo',  name: '志望校別特訓', icon: '🔥',
    match: (u) => String(u.week).startsWith('志望校別特訓') },
];

function unitsOf(cat) { return state.units.filter(cat.match); }

// ---- 画面切り替え ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

// ---- 初期化 ----
async function init() {
  try {
    const res = await fetch('units.json', { cache: 'no-store' });
    state.units = await res.json();
    renderCategories();
    // 単元カードの正誤棒グラフ用に unit.json（小問ラベル）を先読み → 読めたら描き直し
    await Promise.all(state.units.map(async (u) => {
      if (state.unitCache[u.id]) return;
      try {
        const r = await fetch(`units/${u.id}/unit.json`, { cache: 'no-store' });
        state.unitCache[u.id] = await r.json();
      } catch (e) {}
    }));
    renderCategories();
    if (state.category) renderUnits();
  } catch (e) {
    $('#category-list').innerHTML = '<p class="loading">単元の読み込みに失敗しました。</p>';
    console.error(e);
  }
  $('#btn-back-categories').addEventListener('click', () => { renderCategories(); showScreen('screen-categories'); });
  $('#btn-back-units').addEventListener('click', () => { state.current = null; renderUnits(); showScreen('screen-units'); });
  $('#wsm-print-btn').addEventListener('click', printCurrentTab);
  $('#wsm-tab-q').addEventListener('click', () => setTab(false));
  $('#wsm-tab-a').addEventListener('click', () => setTab(true));
  $('#wsm-table-toggle').addEventListener('click', toggleWsmTableHeight);
  initWsmDivider();
  attachPinchZoom('wsm-pages', '#wsm-pages-inner', 'container', 0.5, 2);   // ページは50%〜200%
  // ○×採点のクラウド同期（表示中の画面に応じて再描画）
  gradeSyncInit(() => {
    if (state.current) renderGradeTable();
    else if (state.category) renderUnits();
    else renderCategories();
  });
}

// ---- 小問キー（グループあり: head+label / なし: label）----
function questionGroups(unit) {
  if (unit.questionGroups && unit.questionGroups.length) return unit.questionGroups;
  return [{ head: '', labels: unit.questions || [] }];
}
function questionKeys(unit) {
  const out = [];
  questionGroups(unit).forEach((g) => g.labels.forEach((l) => out.push(g.head ? g.head + l : l)));
  return out;
}

// ---- 単元カードの正誤棒グラフ（全アプリ共通デザイン。○×は1回記録なので緑=○） ----
function unitBarStats(u) {
  const unit = state.unitCache[u.id];
  const keys = unit ? questionKeys(unit) : [];
  const grades = loadGrades(u.id);
  let attempted = 0, good = 0;
  for (const k of keys) {
    const g = grades[k];
    if (g === 'o') { attempted++; good++; }
    else if (g === 'x') { attempted++; }
  }
  return { total: keys.length, attempted, good, low: attempted - good, unanswered: keys.length - attempted };
}
function unitBarBlock(st) {
  if (!(st.total > 0)) return '';
  const pct = (n) => (n / st.total * 100);
  const donePct = Math.round(st.attempted / st.total * 100);
  return `
      <div class="unit-card-bar" title="緑=正解 / 黄=不正解 / 灰=未回答">
        <div class="unit-card-bar-good" style="width:${pct(st.good)}%"></div>
        <div class="unit-card-bar-low" style="width:${pct(st.low)}%"></div>
      </div>
      <div class="unit-card-legend">
        <span class="lg-good">○ ${st.good}</span>
        <span class="lg-low">✕ ${st.low}</span>
        <span class="lg-none">未 ${st.unanswered}</span>
      </div>`;
}
function unitStatsBlock(st) {
  if (!(st.total > 0)) return '';
  const donePct = Math.round(st.attempted / st.total * 100);
  return `
      <div class="unit-card-stats">
        <div class="unit-card-accuracy">${donePct}%</div>
        <div class="unit-card-detail">完了 ${st.attempted}/${st.total}</div>
      </div>`;
}

// ---- カテゴリ一覧 ----
function renderCategories() {
  const list = $('#category-list');
  list.innerHTML = '';
  CATEGORIES.forEach((cat) => {
    const units = unitsOf(cat);
    if (!units.length) return;
    const card = document.createElement('div');
    card.className = 'unit-card';
    card.innerHTML = `
      <div class="unit-card-info">
        <div class="unit-card-title">${cat.icon} ${cat.name}</div>
        <div class="unit-card-subtitle">${units.length}単元</div>
      </div>`;
    card.addEventListener('click', () => openCategory(cat));
    list.appendChild(card);
  });
}

function openCategory(cat) {
  state.category = cat;
  $('#units-header-title').textContent = `${cat.icon} ${cat.name}`;
  renderUnits();
  showScreen('screen-units');
}

// ---- 単元一覧（週ごとにグループ。デイリーサピックスはフラット） ----
function unitIcon(u) {
  if (u.category === 'daily-knowledge') return '📚';
  return u.category === 'knowledge' ? '✍️' : '📖';
}
function unitTag(u) {
  if (u.category === 'daily-knowledge') return '知識の学習・コトノハ・漢字の要';
  return u.category === 'knowledge' ? '知識の総完成' : '読解';
}

function renderUnits() {
  const cat = state.category;
  if (!cat) return;
  const list = $('#unit-list');
  const units = unitsOf(cat);
  const cardHTML = (u) => {
    const st = unitBarStats(u);
    return `
      <div class="unit-card unit-card-color ${u.category}" data-id="${u.id}">
        <span class="unit-icon">${unitIcon(u)}</span>
        <div class="unit-card-info">
          <div class="unit-card-title">${u.title}</div>
          <div class="unit-card-subtitle">${unitTag(u)}</div>${unitBarBlock(st)}
        </div>${unitStatsBlock(st)}
      </div>`;
  };
  let html = '';
  if (cat.id === 'daily') {
    html = units.map(cardHTML).join('');
  } else {
    const groups = {};
    for (const u of units) (groups[u.week] || (groups[u.week] = [])).push(u);
    const weeks = Object.keys(groups).sort(); // 若い週を上に（他アプリと同じ昇順）
    for (const w of weeks) {
      const head = w.replace(/^志望校別特訓\s*/, '');  // カテゴリ名の重複を省く
      html += `<section class="week-group"><h3 class="week-head">${head}</h3>` +
        groups[w].map(cardHTML).join('') + '</section>';
    }
  }
  list.innerHTML = html || '<p class="loading">まだ単元がありません。</p>';
  list.querySelectorAll('.unit-card[data-id]').forEach((c) =>
    c.addEventListener('click', () => openUnit(c.dataset.id)));
}

// ---- 単元を開く（即・問題ページ） ----
async function openUnit(id) {
  let unit = state.unitCache[id];
  if (!unit) {
    const res = await fetch(`units/${id}/unit.json`, { cache: 'no-store' });
    unit = await res.json();
    state.unitCache[id] = unit;
  }
  state.current = unit;
  state.showingAnswer = false;
  $('#unit-title').textContent = unit.title;
  renderGradeTable();
  restoreWsmTableHeight();
  renderPages();
  updateTabUI();
  showScreen('screen-unit');
  $('#wsm-pages').scrollTop = 0;
}

// ---- タブ切替（問題/解答） ----
function setTab(showAnswer) {
  if (!state.current || state.showingAnswer === showAnswer) return;
  state.showingAnswer = showAnswer;
  applyTabVisibility();
  updateTabUI();
  $('#wsm-pages').scrollTop = 0;
}
function updateTabUI() {
  $('#wsm-tab-q').classList.toggle('active', !state.showingAnswer);
  $('#wsm-tab-a').classList.toggle('active', state.showingAnswer);
}
function applyTabVisibility() {
  document.querySelectorAll('#wsm-pages .wsm-page[data-pt="q"]').forEach((e) => e.style.display = state.showingAnswer ? 'none' : '');
  document.querySelectorAll('#wsm-pages .wsm-page[data-pt="a"]').forEach((e) => e.style.display = state.showingAnswer ? '' : 'none');
}

// ---- ページ画像の描画（フル解像度・遅延読み込み） ----
function renderPages() {
  const u = state.current;
  const el = $('#wsm-pages-inner');
  const q = (u.questionPages || []).map((p, i) => `
      <div class="wsm-page" data-pt="q">
        <div class="wsm-page-label">問題 ${i + 1} / ${u.questionPages.length}</div>
        <img src="${p.full}" loading="lazy" alt="問題${i + 1}">
      </div>`).join('');
  const a = (u.answerPages || []).map((p, i) => `
      <div class="wsm-page" data-pt="a" style="display:none">
        <div class="wsm-page-label">解答 ${i + 1} / ${u.answerPages.length}</div>
        <img src="${p.full}" loading="lazy" alt="解答${i + 1}">
      </div>`).join('');
  el.innerHTML = q + a;
  applyTabVisibility();
}

// ---- 正誤表（両タブ共通・常時表示。○×は1回記録のトグル） ----
function renderGradeTable() {
  const u = state.current;
  const el = $('#wsm-table');
  if (!u) { el.innerHTML = ''; return; }
  const grades = loadGrades(u.id);
  const prevScroll = el.scrollTop;
  el.innerHTML = questionGroups(u).map((g) => {
    const subs = g.labels.map((label) => {
      const key = g.head ? g.head + label : label;
      const v = grades[key] || '';
      const tint = v === 'o' ? 'sub-perfect' : v === 'x' ? 'sub-low' : '';
      const keyEsc = key.replace(/"/g, '&quot;');
      return `<span class="wsm-sub ${tint}" data-key="${keyEsc}">
        <span class="wsm-sub-label">${label}</span>
        <button class="wsm-qc-btn ok ${v === 'o' ? 'selected' : ''}" data-v="o">○</button>
        <button class="wsm-qc-btn ng ${v === 'x' ? 'selected' : ''}" data-v="x">✕</button>
      </span>`;
    }).join('');
    return `<div class="wsm-daimon">
      ${g.head ? `<div class="wsm-daimon-head">${g.head}</div>` : ''}
      <div class="wsm-sub-row">${subs}</div>
    </div>`;
  }).join('');
  el.scrollTop = prevScroll;
  el.querySelectorAll('.wsm-qc-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.closest('.wsm-sub').dataset.key;
      const v = btn.dataset.v;
      const g = loadGrades(u.id);
      g[key] = (g[key] === v) ? '' : v;  // 同じボタン再タップで解除
      saveGrades(u.id, g);
      renderGradeTable();
    });
  });
}

// ==============================
// 正誤表の高さ: ドラッグバーで可変（最小〜画面の半分）＋「広げる」は半分まで
// ==============================
const WSM_TABLE_MIN_H = 34;
function wsmTableMaxH() { return Math.max(200, Math.round(window.innerHeight * 0.5)); }   // 非表示時ガード200px
function wsmTableDefaultH() { return 64; }
function setWsmTableHeight(h, persist) {
  const t = $('#wsm-table');
  if (!t) return;
  h = Math.max(WSM_TABLE_MIN_H, Math.min(wsmTableMaxH(), Math.round(h)));
  t.style.maxHeight = h + 'px';
  t.style.height = h + 'px';
  const chev = document.querySelector('#wsm-table-toggle .wsm-table-chev');
  const big = h >= wsmTableMaxH() - 2;
  if (chev) chev.textContent = big ? '△ 閉じる' : '▽ 広げる';
  if (persist) { try { localStorage.setItem('wsm-table-h', String(h)); } catch (e) {} }
}
function restoreWsmTableHeight() {
  let h = wsmTableDefaultH();
  try { const s = parseInt(localStorage.getItem('wsm-table-h') || '', 10); if (s > 0) h = s; } catch (e) {}
  setWsmTableHeight(h, false);
}
function toggleWsmTableHeight() {
  const t = $('#wsm-table');
  if (!t) return;
  const cur = t.getBoundingClientRect().height;
  if (cur >= wsmTableMaxH() - 2) setWsmTableHeight(wsmTableDefaultH(), true);
  else setWsmTableHeight(wsmTableMaxH(), true);
}
function initWsmDivider() {
  const bar = $('#wsm-divider');
  const t = $('#wsm-table');
  if (!bar || !t || bar._init) return;
  bar._init = true;
  let startY = 0, startH = 0, dragging = false;
  const onMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    setWsmTableHeight(startH + (ev.clientY - startY), false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    setWsmTableHeight(t.getBoundingClientRect().height, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  bar.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    dragging = true;
    startY = ev.clientY;
    startH = t.getBoundingClientRect().height;
    bar.classList.add('dragging');
    try { bar.setPointerCapture(ev.pointerId); } catch (e) {}
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

// ==============================
// 印刷（表示中タブ）: デイリーサピックスはB4横に2ページ/枚（縦書き=右→左）、
// Weekly SapiX（横長画像）は1画像=1ページ
// ==============================
const imageCache = {};
function loadImage(src) {
  if (imageCache[src]) return Promise.resolve(imageCache[src]);
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => { imageCache[src] = img; resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}

async function printCurrentTab() {
  const u = state.current;
  if (!u) return;
  const pages = state.showingAnswer ? u.answerPages : u.questionPages;
  if (!pages || !pages.length) return;
  const imgs = [];
  for (const p of pages) {
    try { imgs.push(await loadImage(p.full)); } catch (e) {}
  }
  if (!imgs.length) { alert('画像の読み込みに失敗しました'); return; }
  const dataURLs = u.print2up ? build2upSheets(imgs) : imgs.map((img) => {
    const cc = document.createElement('canvas');
    cc.width = img.width; cc.height = img.height;
    cc.getContext('2d').drawImage(img, 0, 0);
    return cc.toDataURL('image/jpeg', 0.92);
  });
  _openPrintOverlay(dataURLs);
}

// 縦長ページ2枚を1枚のB4横シートへ（縦書きの読み順=1枚目を右・2枚目を左）
function build2upSheets(imgs) {
  const out = [];
  for (let i = 0; i < imgs.length; i += 2) {
    const right = imgs[i];
    const left = imgs[i + 1] || null;
    const H = Math.max(right.height, left ? left.height : 0);
    const rw = Math.round(right.width * H / right.height);
    const lw = left ? Math.round(left.width * H / left.height) : rw;
    const gutter = Math.round(H * 0.015);
    const W = rw + lw + gutter;
    const cc = document.createElement('canvas');
    cc.width = W; cc.height = H;
    const ctx = cc.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(right, W - rw, 0, rw, H);
    if (left) ctx.drawImage(left, 0, 0, lw, H);
    out.push(cc.toDataURL('image/jpeg', 0.92));
  }
  return out;
}

// ---- プリントオーバーレイ（理科v2/社会v2と同方式・iPad対応） ----
// ★高さ上限は必ず物理mm(vh禁止)。vhはiOS Safariの印刷で端末ごとに換算が狂う。
let _printActiveBlobURLs = [];
function _dataURLtoBlobURL(dataURL) {
  const [head, b64] = dataURL.split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/png'])[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}
function _resetPrintOverlay() {
  const body = $('#print-overlay-body');
  if (body) body.innerHTML = '';
  _printActiveBlobURLs.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
  _printActiveBlobURLs = [];
}
function _setPrintPageGeometry(img) {
  const portrait = !!(img && img.naturalHeight > img.naturalWidth);
  const pageSize = portrait ? 'A4 portrait' : 'B4 landscape';
  const maxH = portrait ? 285 : 245;   // 印刷可能高(mm)
  let style = document.getElementById('dynamic-print-page');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamic-print-page';
    document.head.appendChild(style);
  }
  style.textContent =
    `@page { size: ${pageSize}; margin: 5mm; }\n` +
    `@media print { #print-overlay-body .pg img { max-height: ${maxH}mm !important; } }`;
}
function _openPrintOverlay(dataURLs) {
  const body = $('#print-overlay-body');
  if (!body) return;
  _resetPrintOverlay();
  _printActiveBlobURLs = dataURLs.map(_dataURLtoBlobURL);
  body.innerHTML = _printActiveBlobURLs
    .map((u) => `<div class="pg"><img class="pi" src="${u}"></div>`).join('');
  const imgs = Array.from(body.querySelectorAll('img.pi'));
  const waits = imgs.map((im) => im.decode
    ? im.decode().catch(() => {})
    : new Promise((r) => { im.onload = r; im.onerror = r; if (im.complete) r(); }));
  Promise.all(waits).then(() => {
    _setPrintPageGeometry(imgs[0]);
    requestAnimationFrame(() => {
      try { window.print(); } catch (e) { console.warn('print err', e); }
    });
  });
}

// ==============================
// ピンチズーム（wsm-pages: 50%〜200%・ダブルタップで100%）
// ==============================
function attachPinchZoom(wrapperId, contentSelector, fit = 'media', minScale = 1, maxScale = 4) {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  let scale = 1;
  let startDist = 0, startScale = 1;
  let isPinching = false;
  let baseWidth = 0;
  let panStartX = 0, panStartY = 0;
  let panScrollL = 0, panScrollT = 0;
  let isPanning = false;

  function getContent() { return wrapper.querySelector(contentSelector); }
  function getBaseWidth() {
    const cvs = getContent();
    if (!cvs) return 0;
    if (scale === 1) baseWidth = cvs.getBoundingClientRect().width;
    return baseWidth;
  }
  function applyZoom(midXClient, midYClient) {
    const cvs = getContent();
    if (!cvs) return;
    const bw = getBaseWidth() || wrapper.clientWidth;
    const newW = bw * scale;
    const prevScrollLeft = wrapper.scrollLeft;
    const prevScrollTop = wrapper.scrollTop;
    const wRect = wrapper.getBoundingClientRect();
    const canvasX = prevScrollLeft + midXClient - wRect.left;
    const canvasY = prevScrollTop + midYClient - wRect.top;
    const ratioX = canvasX / (cvs.offsetWidth || 1);
    const ratioY = canvasY / (cvs.offsetHeight || 1);
    cvs.style.width = newW + 'px';
    cvs.style.maxWidth = 'none';
    cvs.style.maxHeight = 'none';
    cvs.style.height = 'auto';
    if (fit === 'container') { cvs.style.marginLeft = 'auto'; cvs.style.marginRight = 'auto'; }
    const newCanvasX = ratioX * cvs.offsetWidth;
    const newCanvasY = ratioY * cvs.offsetHeight;
    wrapper.scrollLeft = newCanvasX - (midXClient - wRect.left);
    wrapper.scrollTop = newCanvasY - (midYClient - wRect.top);
  }
  function resetZoom() {
    const cvs = getContent();
    if (!cvs) return;
    scale = 1;
    cvs.style.marginLeft = ''; cvs.style.marginRight = '';
    cvs.style.width = '100%';
    cvs.style.maxWidth = 'none';
    cvs.style.maxHeight = 'none';
    cvs.style.height = 'auto';
    baseWidth = cvs.getBoundingClientRect().width || (wrapper.clientWidth - 20);
  }
  function getDist(t1, t2) {
    const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  wrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      isPinching = true; isPanning = false;
      startDist = getDist(e.touches[0], e.touches[1]);
      startScale = scale;
      if (scale === 1) getBaseWidth();
    } else if (e.touches.length === 1) {
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panScrollL = wrapper.scrollLeft;
      panScrollT = wrapper.scrollTop;
    }
  }, { passive: true });
  wrapper.addEventListener('touchmove', (e) => {
    if (isPinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = getDist(e.touches[0], e.touches[1]);
      scale = Math.min(maxScale, Math.max(minScale, startScale * (dist / startDist)));
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      applyZoom(midX, midY);
    } else if (isPanning && e.touches.length === 1) {
      e.preventDefault();
      const dx = panStartX - e.touches[0].clientX;
      const dy = panStartY - e.touches[0].clientY;
      wrapper.scrollLeft = panScrollL + dx;
      wrapper.scrollTop = panScrollT + dy;
    }
  }, { passive: false });
  wrapper.addEventListener('touchend', (e) => {
    if (isPinching && e.touches.length < 2) {
      isPinching = false;
      if (scale > 0.95 && scale < 1.05) resetZoom();   // 100%付近はぴったり戻す（縮小は保持）
    }
    if (e.touches.length === 0) isPanning = false;
  }, { passive: true });
  let lastTap = 0;
  wrapper.addEventListener('touchend', (e) => {
    if (e.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTap < 300 && scale !== 1) {
      resetZoom();
      wrapper.scrollTop = 0;
    }
    lastTap = now;
  }, { passive: true });
  const cvs = getContent();
  if (cvs) {
    const observer = new MutationObserver(() => resetZoom());
    observer.observe(cvs, { childList: true });
  }
}

// ---- 家族共有クラウド同期（○×採点を端末非依存にする） ----
// GAS（kakomon リポジトリの grade-sync.gs と共通）を「アクセス: 全員」でデプロイ済み。
const GRADE_SYNC_URL = localStorage.getItem('grade-sync-url') || 'https://script.google.com/macros/s/AKfycbwvfaMQjYIL56_EodEPWsTU27IRHz4FIkkU9GKt2wwSI1bRNEcK5M1tia3VGGwEQVmy/exec';
const GRADE_SYNC_APP = 'kokugo-ws';
const GRADE_SYNC_PREFIXES = ['kokugo-ws-grade:'];
const GRADE_SYNC_META = 'kokugo-ws-sync-t';   // キーごとの最終更新時刻(ms)

let _gsTimer = null, _gsBusy = false;
function _gsMeta() { try { return JSON.parse(localStorage.getItem(GRADE_SYNC_META)) || {}; } catch (e) { return {}; } }
function _gsSetMeta(m) { try { localStorage.setItem(GRADE_SYNC_META, JSON.stringify(m)); } catch (e) {} }
function _gsKeys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (GRADE_SYNC_PREFIXES.some((p) => k === p || k.startsWith(p))) out.push(k);
  }
  return out;
}
function gradeSyncTouch(key) {
  if (!GRADE_SYNC_URL) return;
  const m = _gsMeta(); m[key] = Date.now(); _gsSetMeta(m);
  clearTimeout(_gsTimer);
  _gsTimer = setTimeout(gradeSyncPush, 800);
}
async function gradeSyncPush() {
  if (!GRADE_SYNC_URL) return;
  const m = _gsMeta();
  let metaChanged = false;
  const entries = {};
  for (const k of _gsKeys()) {
    const v = localStorage.getItem(k);
    if (v == null) continue;
    if (!m[k]) { m[k] = Date.now(); metaChanged = true; }
    entries[k] = { v, t: m[k] };
  }
  if (metaChanged) _gsSetMeta(m);
  if (!Object.keys(entries).length) return;
  try {
    await fetch(GRADE_SYNC_URL, {
      method: 'POST', mode: 'cors',
      headers: { 'Content-Type': 'text/plain' },  // GASのpreflight回避
      body: JSON.stringify({ app: GRADE_SYNC_APP, entries }),
    });
  } catch (e) { console.warn('gradeSyncPush failed:', e); }
}
async function gradeSyncPull(onUpdate) {
  if (!GRADE_SYNC_URL || _gsBusy) return;
  _gsBusy = true;
  try {
    const res = await fetch(GRADE_SYNC_URL + '?app=' + encodeURIComponent(GRADE_SYNC_APP), { mode: 'cors' });
    const json = await res.json();
    if (json.status !== 'ok' || !json.entries) return;
    const m = _gsMeta();
    let changed = false;
    for (const k in json.entries) {
      if (!GRADE_SYNC_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
      const e = json.entries[k];
      if (!e || typeof e.v !== 'string') continue;
      if (localStorage.getItem(k) == null || (e.t || 0) > (m[k] || 0)) {
        localStorage.setItem(k, e.v);
        m[k] = e.t || 0;
        changed = true;
      }
    }
    if (changed) { _gsSetMeta(m); if (onUpdate) onUpdate(); }
  } catch (e) { console.warn('gradeSyncPull failed:', e); }
  finally { _gsBusy = false; }
}
function gradeSyncInit(onUpdate) {
  if (!GRADE_SYNC_URL) return;
  gradeSyncPull(onUpdate);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { gradeSyncPush(); gradeSyncPull(onUpdate); }
  });
  window.addEventListener('online', () => gradeSyncPush());
}

// ---- ○×の保存（従来キーを維持） ----
function gradeKey(id) { return `kokugo-ws-grade:${id}`; }
function loadGrades(id) {
  try { return JSON.parse(localStorage.getItem(gradeKey(id))) || {}; }
  catch (e) { return {}; }
}
function saveGrades(id, grades) {
  try { localStorage.setItem(gradeKey(id), JSON.stringify(grades)); } catch (e) {}
  gradeSyncTouch(gradeKey(id));
}

init();
