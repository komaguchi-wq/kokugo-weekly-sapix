/* ===== SapiX 国語（デイリーサピックス / Weekly SapiX 読解 / 知識の総完成 / 夏の漢字特訓 / 志望校別特訓）=====
 * UIは理科v2/社会v2のwsm方式（デイリーサポート方式）に統一:
 *   単元カード → 即・問題ページ（問題/解答タブ + 常時表示の正誤表 + 印刷）
 * ○×は複数回記録（2026-09-06〜・理科v2と同仕様）:
 *   localStorage kokugo-ws-grade:<id> = {小問キー: {a:回答回数, c:正解回数}} + GAS同期。
 *   旧1回記録の 'o'/'x' は {a:1,c:1}/{a:1,c:0} として読み替え（後方互換）。
 *   タップ=仮選択（再タップで取消・10秒放置か画面遷移で1回分として確定）。
 *   モードバーで正答率50%未満（解答済みのみ）/50%未満＆未解答/66%未満/未解答に絞り込み（対象外の小問は薄く表示）。 */
'use strict';

const state = {
  units: [],        // units.json
  unitCache: {},    // id -> unit.json
  category: null,   // 現在のカテゴリ
  current: null,    // 現在表示中の unit.json
  showingAnswer: false,
  deepLinked: false, // ?cat= で国語トップから直接カテゴリを開いた（←は国語トップへ戻す）
};

const GOOD_RATE = 0.6;      // 単元カードの緑=正答率60%以上（全アプリ共通）
const IDLE_TIMEOUT = 10000; // 仮選択を確定するまでの放置時間(ms)

const KOKUGO_TOP_URL = 'https://komaguchi-wq.github.io/kokugo/';

const $ = (sel) => document.querySelector(sel);

// ---- カテゴリ定義（units.json のフィールドから振り分け）----
// bulk: 単元一覧に一括モードバー（全単元の正答率フィルタ＋対象のある単元だけ一括印刷）を出す
const CATEGORIES = [
  { id: 'daily',  name: 'デイリーサピックス', icon: '📚',
    match: (u) => u.category === 'daily-knowledge' },
  { id: 'weekly', name: 'Weekly SapiX 読解', icon: '📖',
    match: (u) => u.category === 'reading' && !String(u.week).startsWith('志望校別特訓') },
  { id: 'weekly-k', name: 'Weekly SapiX 知識の総完成', icon: '✍️', bulk: true,
    match: (u) => u.category === 'knowledge' && !String(u.week).startsWith('志望校別特訓') },
  { id: 'kanji',  name: '夏の漢字特訓', icon: '🌻', bulk: true,
    match: (u) => u.category === 'kanji-tokkun' },
  { id: 'ss', name: 'SS特訓', icon: '🎯',
    match: (u) => u.category === 'ss-tokkun' },
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
    // 国語トップからのカテゴリ直リンク（?cat=daily|weekly|kanji|shibo）
    const deepCat = new URLSearchParams(location.search).get('cat');
    const cat = deepCat && CATEGORIES.find((c) => c.id === deepCat);
    if (cat && unitsOf(cat).length) {
      state.deepLinked = true;
      openCategory(cat);
    }
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
  $('#btn-back-categories').addEventListener('click', () => {
    if (state.deepLinked) { location.href = KOKUGO_TOP_URL; return; }  // 直リンク時は国語トップへ
    renderCategories();
    showScreen('screen-categories');
  });
  $('#btn-back-units').addEventListener('click', () => {
    commitGrades();   // 仮選択を確定してから戻る
    state.current = null;
    renderUnits();
    showScreen('screen-units');
  });
  document.querySelectorAll('#wsm-modebar [data-wsm-mode]').forEach((btn) =>
    btn.addEventListener('click', () => setWsFilter(btn.dataset.wsmMode)));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') commitGrades();
  });
  $('#wsm-print-btn').addEventListener('click', printCurrentTab);
  $('#wsm-tab-q').addEventListener('click', () => setTab(false));
  $('#wsm-tab-a').addEventListener('click', () => setTab(true));
  $('#wsm-table-toggle').addEventListener('click', toggleWsmTableHeight);
  initWsmDivider();
  attachPinchZoom('wsm-pages', '#wsm-pages-inner', 'container', 0.5, 2);   // ページは50%〜200%
  // ○×採点のクラウド同期（表示中の画面に応じて再描画）
  gradeSyncInit(() => {
    if (state.current) { renderGradeTable(); updateModeBar(); }
    else if (state.category) renderUnits();
    else renderCategories();
  });
}

// ---- 正誤の複数回記録 ----
// 保存値は {a:回答回数, c:正解回数}。旧1回記録 'o'/'x' は読み替えで後方互換。
function gradeStat(grades, key) {
  const v = grades[key];
  if (!v) return { a: 0, c: 0 };
  if (v === 'o') return { a: 1, c: 1 };
  if (v === 'x') return { a: 1, c: 0 };
  return { a: v.a || 0, c: v.c || 0 };
}

let pendingGrades = {};   // key -> 'o'|'x'（仮選択。確定前）
let gradeIdleTimer = null;

function markGrade(key, v) {
  if (pendingGrades[key] === v) delete pendingGrades[key];  // 同じボタン再タップで仮選択取消
  else pendingGrades[key] = v;
  renderGradeTable();
  if (gradeIdleTimer) clearTimeout(gradeIdleTimer);
  if (Object.keys(pendingGrades).length) gradeIdleTimer = setTimeout(commitGrades, IDLE_TIMEOUT);
}

function commitGrades() {
  if (gradeIdleTimer) { clearTimeout(gradeIdleTimer); gradeIdleTimer = null; }
  const keys = Object.keys(pendingGrades);
  if (!keys.length || !state.current) { pendingGrades = {}; return; }
  const u = state.current;
  const g = loadGrades(u.id);
  for (const k of keys) {
    const st = gradeStat(g, k);
    g[k] = { a: st.a + 1, c: st.c + (pendingGrades[k] === 'o' ? 1 : 0) };
  }
  pendingGrades = {};
  saveGrades(u.id, g);
  if (document.querySelector('#screen-unit.active')) { renderGradeTable(); updateModeBar(); }
}

// ---- 正答率フィルタ（モードバー。理科v2と同仕様）----
// ★2026-09-06 モード再編: below50/below67=解答済みのみ（未解答を除外）、
//   below50u=50%未満＋未解答（従来の below50 相当）。below99(80%未満)は廃止
let wsmFilter = 'all';
const WSM_MODE_SHORT = {
  all: '全ての問題', below50: '正答率50%未満', below50u: '50%未満＆未解答',
  below67: '正答率66%未満', unanswered: '未解答問題',
};
function keyMatchesMode(grades, key, mode) {
  const st = gradeStat(grades, key);
  const pct = st.a ? st.c / st.a * 100 : null;
  if (mode === 'unanswered') return st.a === 0;
  if (mode === 'below50') return pct !== null && pct < 50;
  if (mode === 'below50u') return pct === null || pct < 50;
  if (mode === 'below67') return pct !== null && pct < 66;
  return true; // all
}
function setWsFilter(mode) {
  commitGrades();
  wsmFilter = mode;
  renderGradeTable();
  updateModeBar();
  if (state.current && state.current.cellRects) renderPages();   // 対象マスの赤枠を更新
}
function updateModeBar() {
  const u = state.current;
  if (!u) return;
  const grades = loadGrades(u.id);
  const keys = questionKeys(u);
  document.querySelectorAll('#wsm-modebar [data-wsm-mode]').forEach((btn) => {
    const m = btn.dataset.wsmMode;
    const n = keys.filter((k) => keyMatchesMode(grades, k, m)).length;
    btn.textContent = `${WSM_MODE_SHORT[m]} (${n})`;
    btn.classList.toggle('active', m === wsmFilter);
    btn.disabled = n === 0 && m !== 'all';
  });
}

// ---- 一括カテゴリ（漢字特訓/知識の総完成）: 正答率フィルタの対象小問 ----
function targetKeys(unit, mode) {
  if (mode === 'all') return [];
  const grades = loadGrades(unit.id);
  return questionKeys(unit).filter((k) => keyMatchesMode(grades, k, mode));
}

// 合成ページ(qp_1)の解答らんセルに赤枠オーバーレイ（unit.cellRects = 0〜1割合座標）
function kanjiMarksHTML(unit, mode) {
  if (!unit.cellRects || mode === 'all') return '';
  return targetKeys(unit, mode).map((k) => {
    const r = unit.cellRects[k];
    if (!r) return '';
    return `<div class="kanji-mark" style="left:${(r[0] * 100).toFixed(2)}%;top:${(r[1] * 100).toFixed(2)}%;` +
           `width:${((r[2] - r[0]) * 100).toFixed(2)}%;height:${((r[3] - r[1]) * 100).toFixed(2)}%"></div>`;
  }).join('');
}

// 印刷用: 合成ページに赤枠を焼き込む（枠線は画像幅比例・最低8px = 全アプリ共通ルール）
function drawKanjiSheet(img, unit, keys) {
  const cc = document.createElement('canvas');
  cc.width = img.width; cc.height = img.height;
  const ctx = cc.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = Math.max(8, img.width * 0.004);
  for (const k of keys) {
    const r = unit.cellRects[k];
    if (!r) continue;
    ctx.strokeRect(r[0] * img.width, r[1] * img.height,
                   (r[2] - r[0]) * img.width, (r[3] - r[1]) * img.height);
  }
  return cc.toDataURL('image/jpeg', 0.92);
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

// ---- 単元カードの正誤棒グラフ（全アプリ共通デザイン。緑=正答率60%以上/黄=未満/灰=未） ----
function unitBarStats(u) {
  const unit = state.unitCache[u.id];
  const keys = unit ? questionKeys(unit) : [];
  const grades = loadGrades(u.id);
  let attempted = 0, good = 0;
  for (const k of keys) {
    const st = gradeStat(grades, k);
    if (st.a > 0) { attempted++; if (st.c / st.a >= GOOD_RATE) good++; }
  }
  return { total: keys.length, attempted, good, low: attempted - good, unanswered: keys.length - attempted };
}
function unitBarBlock(st) {
  if (!(st.total > 0)) return '';
  const pct = (n) => (n / st.total * 100);
  const donePct = Math.round(st.attempted / st.total * 100);
  return `
      <div class="unit-card-bar" title="緑=正答率60%以上 / 黄=60%未満 / 灰=未回答">
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
  if (u.category === 'kanji-tokkun') return '🌻';
  if (u.category === 'ss-tokkun') return '🎯';
  return u.category === 'knowledge' ? '✍️' : '📖';
}
function unitTag(u) {
  if (u.category === 'daily-knowledge') return '知識の学習・コトノハ・漢字の要';
  if (u.category === 'kanji-tokkun') return '漢字20問';
  if (u.category === 'ss-tokkun') return u.tag || 'SS特訓';
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
  if (cat.bulk) {
    // 一括モードバー（全単元の対象問題の確認と、対象のある単元だけの一括印刷）
    const bf = bulkFilterOf(cat);
    const noun = cat.id === 'kanji' ? '回' : '単元';
    const bulkTargets = (u) => {
      const unit = state.unitCache[u.id];
      return unit ? targetKeys(unit, bf) : [];
    };
    const bulkCount = (m) => units.filter((u) => {
      const unit = state.unitCache[u.id];
      if (!unit) return false;
      return m === 'all' || targetKeys(unit, m).length > 0;
    }).length;
    html = `<div class="wsm-modebar kanji-bulkbar">` +
      ['all', 'below50', 'below50u', 'below67', 'unanswered'].map((m) =>
        `<button class="wsm-mode-btn ${m === bf ? 'active' : ''}" data-kb-mode="${m}">` +
        `${WSM_MODE_SHORT[m]} (${bulkCount(m)}${noun})</button>`).join('') +
      `</div>
      <div class="kanji-bulk-actions">
        <span class="kanji-bulk-hint">${bf === 'all'
          ? `${noun}を選ぶか、モードを選んで対象問題をしぼりこめます`
          : `各${noun}の「対象」が印刷対象${cat.id === 'kanji' ? '（赤枠つき）' : ''}。対象0問の${noun}は印刷されません`}</span>
        <span class="kanji-bulk-btns">
          <button class="btn-bulk-print" data-bulk-print="q">🖨 問題を印刷（${bf === 'all'
            ? `全${units.length}${noun}` : `${bulkCount(bf)}${noun}`}）</button>
          <button class="btn-bulk-print btn-bulk-print-a" data-bulk-print="a">🖨 解答を印刷（${bf === 'all'
            ? `全${units.length}${noun}` : `${bulkCount(bf)}${noun}`}）</button>
        </span>
      </div>`;
    html += units.map((u) => {
      if (bf === 'all') return cardHTML(u);
      const t = bulkTargets(u);
      const info = t.length
        ? `<div class="kanji-targets">対象: ${t.join(' ')}（${t.length}問）</div>`
        : `<div class="kanji-targets kanji-targets-none">対象なし（印刷されません）</div>`;
      return cardHTML(u).replace(/(<div class="unit-card-subtitle">[^<]*<\/div>)/, `$1${info}`);
    }).join('');
  } else if (cat.id === 'daily') {
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
  list.querySelectorAll('[data-kb-mode]').forEach((btn) =>
    btn.addEventListener('click', () => { bulkFilters[cat.id] = btn.dataset.kbMode; renderUnits(); }));
  list.querySelectorAll('[data-bulk-print]').forEach((btn) =>
    btn.addEventListener('click', () => bulkPrint(btn.dataset.bulkPrint)));
}

// ---- 一括印刷（漢字特訓/知識の総完成。対象0問の単元はスキップ）----
// kind='q': cellRects のある単元（漢字特訓）は対象マスに赤枠を焼き込み、無い単元は問題ページをそのまま印刷。
// kind='a': 解答ページを印刷（print2up の単元＝漢字特訓は 解答+解いた原本 をB4横2upに合成、単元内の解答印刷と同じ）。
const bulkFilters = {};   // cat.id -> モードキー
function bulkFilterOf(cat) { return bulkFilters[cat.id] || 'all'; }
function plainSheet(img) {
  const cc = document.createElement('canvas');
  cc.width = img.width; cc.height = img.height;
  cc.getContext('2d').drawImage(img, 0, 0);
  return cc.toDataURL('image/jpeg', 0.92);
}
async function bulkPrint(kind) {
  const cat = state.category;
  if (!cat || !cat.bulk) return;
  const bf = bulkFilterOf(cat);
  const sheets = [];
  for (const u of unitsOf(cat)) {
    const unit = state.unitCache[u.id];
    if (!unit) continue;
    const keys = targetKeys(unit, bf);
    if (bf !== 'all' && keys.length === 0) continue;   // 対象なしの単元は印刷しない
    try {
      if (kind === 'a') {
        const imgs = [];
        for (const p of unit.answerPages || []) imgs.push(await loadImage(p.full));
        if (!imgs.length) continue;
        if (unit.print2up) sheets.push(...build2upSheets(imgs));
        else imgs.forEach((img) => sheets.push(plainSheet(img)));
      } else if (unit.cellRects) {
        const img = await loadImage(unit.questionPages[0].full);
        sheets.push(drawKanjiSheet(img, unit, keys));
      } else {
        for (const p of unit.questionPages || []) sheets.push(plainSheet(await loadImage(p.full)));
      }
    } catch (e) { console.warn('bulk print load fail', u.id, e); }
  }
  if (!sheets.length) { alert('対象問題のある単元がありません'); return; }
  _openPrintOverlay(sheets);
}

// ---- 単元を開く（即・問題ページ） ----
async function openUnit(id) {
  commitGrades();          // 前の単元の仮選択を確定
  wsmFilter = 'all';
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
  updateModeBar();
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
  const marks = kanjiMarksHTML(u, wsmFilter);
  const q = (u.questionPages || []).map((p, i) => `
      <div class="wsm-page" data-pt="q">
        <div class="wsm-page-label">問題 ${i + 1} / ${u.questionPages.length}${marks ? '（赤枠=対象問題）' : ''}</div>
        <div class="kanji-wrap"><img src="${p.full}" loading="lazy" alt="問題${i + 1}">${i === 0 ? marks : ''}</div>
      </div>`).join('');
  const a = (u.answerPages || []).map((p, i) => `
      <div class="wsm-page" data-pt="a" style="display:none">
        <div class="wsm-page-label">解答 ${i + 1} / ${u.answerPages.length}</div>
        <img src="${p.full}" loading="lazy" alt="解答${i + 1}">
      </div>`).join('');
  el.innerHTML = q + a;
  applyTabVisibility();
}

// ---- 正誤表（両タブ共通・常時表示。○×は複数回記録: タップ=仮選択→放置/遷移で確定） ----
function renderGradeTable() {
  const u = state.current;
  const el = $('#wsm-table');
  if (!u) { el.innerHTML = ''; return; }
  const grades = loadGrades(u.id);
  const prevScroll = el.scrollTop;
  el.innerHTML = questionGroups(u).map((g) => {
    const subs = g.labels.map((label) => {
      const key = g.head ? g.head + label : label;
      const st = gradeStat(grades, key);
      let tint = '';
      if (st.a > 0) {
        const acc = st.c / st.a;
        tint = acc >= 0.999 ? 'sub-perfect' : acc >= 0.5 ? 'sub-mid' : 'sub-low';
      }
      const dim = wsmFilter !== 'all' && !keyMatchesMode(grades, key, wsmFilter) ? 'ws-dim' : '';
      const pend = pendingGrades[key] || '';
      const cnt = st.a > 0 ? `${st.c}/${st.a}` : '';
      const keyEsc = key.replace(/"/g, '&quot;');
      return `<span class="wsm-sub ${tint} ${dim}" data-key="${keyEsc}">
        <span class="wsm-sub-label">${label}</span>
        <button class="wsm-qc-btn ok ${pend === 'o' ? 'selected' : ''}" data-v="o">○</button>
        <button class="wsm-qc-btn ng ${pend === 'x' ? 'selected' : ''}" data-v="x">✕</button>
        <span class="wsm-sub-count">${cnt}</span>
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
      markGrade(btn.closest('.wsm-sub').dataset.key, btn.dataset.v);
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
  if (!state.showingAnswer && u.cellRects) {   // 漢字特訓: 合成1枚＋対象マスの赤枠
    try {
      const img = await loadImage(u.questionPages[0].full);
      _openPrintOverlay([drawKanjiSheet(img, u, targetKeys(u, wsmFilter))]);
    } catch (e) { alert('画像の読み込みに失敗しました'); }
    return;
  }
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
