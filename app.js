/* ===== Weekly SapiX 国語 ビューア ロジック ===== */
'use strict';

const state = {
  units: [],        // units.json
  unitCache: {},    // id -> unit.json
  current: null,    // 現在表示中の unit.json
  view: 'question', // 'question' | 'answer'
};

const $ = (sel) => document.querySelector(sel);

// ---- 初期化 ----
async function init() {
  try {
    const res = await fetch('units.json', { cache: 'no-store' });
    state.units = await res.json();
    renderHome();
  } catch (e) {
    $('#unit-list').innerHTML = '<p class="loading">単元の読み込みに失敗しました。</p>';
    console.error(e);
  }
  $('#back-btn').addEventListener('click', showHome);
  $('#print-btn').addEventListener('click', doPrint);
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#lightbox-close').addEventListener('click', closeLightbox);
  // ○×採点のクラウド同期（単元表示中なら取り込み後に再描画）
  gradeSyncInit(() => { if (state.current) renderPages(); });
}

// ---- ホーム（週ごとにグループ表示） ----
function renderHome() {
  const groups = {};
  for (const u of state.units) {
    (groups[u.week] || (groups[u.week] = [])).push(u);
  }
  const weeks = Object.keys(groups).sort().reverse(); // 新しい週を上に
  if (!weeks.length) {
    $('#unit-list').innerHTML = '<p class="loading">まだ単元がありません。</p>';
    return;
  }
  let html = '';
  for (const w of weeks) {
    html += `<section class="week-group"><h3 class="week-head">${w}</h3><div class="unit-grid">`;
    for (const u of groups[w]) {
      const isK = u.category === 'knowledge';
      const icon = isK ? '✍️' : '📖';
      const tag = isK ? '知識の総完成' : '読解';
      html += `
        <div class="unit-card ${u.category}" data-id="${u.id}">
          <span class="unit-icon">${icon}</span>
          <div>
            <div class="unit-name">${u.title}</div>
            <div class="unit-tag">${tag}</div>
          </div>
        </div>`;
    }
    html += '</div></section>';
  }
  const list = $('#unit-list');
  list.innerHTML = html;
  list.querySelectorAll('.unit-card').forEach((c) =>
    c.addEventListener('click', () => openUnit(c.dataset.id)));
}

// ---- 単元を開く ----
async function openUnit(id) {
  let unit = state.unitCache[id];
  if (!unit) {
    const res = await fetch(`units/${id}/unit.json`, { cache: 'no-store' });
    unit = await res.json();
    state.unitCache[id] = unit;
  }
  state.current = unit;
  state.view = 'question';
  $('#detail-title').textContent = unit.title;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === 'question'));
  $('#home').hidden = true;
  $('#detail').hidden = false;
  $('#back-btn').hidden = false;
  window.scrollTo(0, 0);
  renderPages();
}

function showHome() {
  $('#detail').hidden = true;
  $('#home').hidden = false;
  $('#back-btn').hidden = true;
  state.current = null;
}

// ---- ビュー切替（問題/解答） ----
function switchView(view) {
  if (!state.current || view === state.view) return;
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo(0, 0);
  renderPages();
}

// ---- ページ画像の描画 ----
function currentPages() {
  const u = state.current;
  return state.view === 'question' ? u.questionPages : u.answerPages;
}

function renderPages() {
  const pages = currentPages();
  const note = $('#view-note');
  if (state.view === 'question') {
    note.textContent = '問題文と解答用紙（空欄）です。画像をタップで拡大できます。';
  } else {
    note.textContent = state.current.hasSolved
      ? '解答解説と、記入済みの解答用紙です。'
      : '解答解説です（この単元は解答用紙の記入がありません）。';
  }
  const stack = $('#page-stack');
  // 解答ビューの先頭に「小問ごと○×」採点パネルを出す
  const gradingHtml = (state.view === 'answer') ? renderGrading() : '';
  const pagesHtml = (!pages || !pages.length)
    ? '<p class="loading">ページがありません。</p>'
    : pages.map((p, i) => `
        <div class="page-item">
          <img src="${p.small}" data-full="${p.full}" alt="ページ${i + 1}" loading="lazy">
        </div>`).join('');
  stack.innerHTML = gradingHtml + pagesHtml;
  stack.querySelectorAll('.page-item img').forEach((img) =>
    img.addEventListener('click', () => openLightbox(img.dataset.full)));
  bindGrading();
}

// ---- 家族共有クラウド同期（○×採点を端末非依存にする） ----
// GAS（kakomon リポジトリの grade-sync.gs と共通）を「アクセス: 全員」でデプロイし、
// /exec URL を下の "" に入れると有効になる。未設定の間は従来通り端末内保存のみ。
const GRADE_SYNC_URL = localStorage.getItem('grade-sync-url') || '';
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
// 採点の保存時に呼ぶ: 更新時刻を記録し、0.8秒後にまとめて送信
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
    if (!m[k]) { m[k] = Date.now(); metaChanged = true; }  // 同期導入前からのデータに時刻を付与
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
// クラウドの新しいキーだけ取り込み → 変化があれば画面更新
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

// ---- 小問ごと○×採点（点数表示なし・localStorage保存） ----
function gradeKey(id) { return `kokugo-ws-grade:${id}`; }

function loadGrades(id) {
  try { return JSON.parse(localStorage.getItem(gradeKey(id))) || {}; }
  catch (e) { return {}; }
}
function saveGrades(id, grades) {
  try { localStorage.setItem(gradeKey(id), JSON.stringify(grades)); } catch (e) {}
  gradeSyncTouch(gradeKey(id));
}

function renderGrading() {
  const u = state.current;
  const qs = u.questions || [];
  if (!qs.length) return '';
  const grades = loadGrades(u.id);
  const rows = qs.map((label) => {
    const v = grades[label] || '';
    return `
      <div class="grade-row">
        <span class="grade-label">${label}</span>
        <button class="grade-btn maru ${v === 'o' ? 'on' : ''}" data-q="${label}" data-v="o">○</button>
        <button class="grade-btn batsu ${v === 'x' ? 'on' : ''}" data-q="${label}" data-v="x">×</button>
      </div>`;
  }).join('');
  return `
    <div class="grading">
      <div class="grading-head">○×をつけよう</div>
      <div class="grade-grid">${rows}</div>
    </div>`;
}

function bindGrading() {
  const u = state.current;
  document.querySelectorAll('.grade-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const grades = loadGrades(u.id);
      const q = btn.dataset.q;
      const v = btn.dataset.v;
      grades[q] = (grades[q] === v) ? '' : v;  // 同じボタン再タップで解除
      saveGrades(u.id, grades);
      // 同じ小問の両ボタンの表示を更新
      document.querySelectorAll(`.grade-btn[data-q="${CSS.escape(q)}"]`).forEach((b) =>
        b.classList.toggle('on', b.dataset.v === grades[q]));
    });
  });
}

// ---- 拡大ライトボックス ----
function openLightbox(fullSrc) {
  const img = $('#lightbox-img');
  img.src = fullSrc;
  $('#lightbox').hidden = false;
  $('.lightbox-scroll').scrollTo(0, 0);
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').src = '';
}

// ---- 印刷（現在のビューを高解像度で・1画像=1ページ） ----
async function doPrint() {
  const pages = currentPages();
  const container = $('#print-container');
  container.innerHTML = pages
    .map((p) => `<div class="print-page"><img src="${p.full}"></div>`)
    .join('');
  // 全画像のデコード完了を待ってから印刷（iOS Safari対策）
  const imgs = Array.from(container.querySelectorAll('img'));
  await Promise.all(imgs.map((im) =>
    im.decode ? im.decode().catch(() => {}) : Promise.resolve()));
  setTimeout(() => window.print(), 100);
}

init();
