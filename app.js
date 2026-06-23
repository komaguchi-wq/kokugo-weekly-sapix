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

// ---- 小問ごと○×採点（点数表示なし・localStorage保存） ----
function gradeKey(id) { return `kokugo-ws-grade:${id}`; }

function loadGrades(id) {
  try { return JSON.parse(localStorage.getItem(gradeKey(id))) || {}; }
  catch (e) { return {}; }
}
function saveGrades(id, grades) {
  try { localStorage.setItem(gradeKey(id), JSON.stringify(grades)); } catch (e) {}
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
