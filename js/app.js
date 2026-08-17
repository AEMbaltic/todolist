/* ============================================================
 * AEM Baltic — Client Task Board
 *
 * Static app. State lives in localStorage and (optionally) syncs
 * to GitHub: data/board.json for tasks, data/img/*.png for
 * pasted screenshots. Images are cached locally in IndexedDB.
 * ============================================================ */
'use strict';

/* ---------------- configuration ---------------- */

const CFG_KEY = 'aem-board-cfg';
const STATE_KEY = 'aem-board-state';
// Window positions are a per-person preference, not shared client data, so they
// stay in this browser and never reach board.json — otherwise every window drag
// would commit to the repository.
const LAYOUT_KEY = 'aem-board-layout';

const MIN_W = 280, MIN_H = 190;
const STACK_BELOW = 820;   // px viewport width under which windows stop floating

const defaultCfg = { owner: 'AEMbaltic', repo: 'todolist', branch: 'main', token: '' };

const defaultState = () => ({
  version: 1,
  updatedAt: 0,
  clients: [
    { id: 'bazevics', name: 'Bazevics', rate: 0, jobs: [], images: [] },
    { id: 'mandrele', name: 'Mandrele', rate: 0, jobs: [], images: [] },
    { id: 'others',   name: 'Others',   rate: 0, jobs: [], images: [] },
  ],
});

let cfg = { ...defaultCfg, ...loadJSON(CFG_KEY) };
let state = normalizeState(loadJSON(STATE_KEY) || defaultState());

let layout = loadJSON(LAYOUT_KEY) || {};   // clientId -> {x,y,w,h,z,collapsed}
let topZ = 10;
let activeClientId = state.clients[0] ? state.clients[0].id : null;
let lightboxRef = null;           // { clientId, imageId }
let dragRef = null;               // { clientId, jobId }
let pushTimer = null;
let syncing = false;
const objectURLs = new Map();     // imageId -> objectURL
const pendingUploads = new Set(); // imageIds not yet on GitHub

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function normalizeState(s) {
  const base = defaultState();
  if (!s || !Array.isArray(s.clients)) return base;
  s.version = s.version || 1;
  s.updatedAt = s.updatedAt || 0;
  for (const c of s.clients) {
    c.rate = Number(c.rate) || 0;
    c.jobs = Array.isArray(c.jobs) ? c.jobs : [];
    c.images = Array.isArray(c.images) ? c.images : [];
    for (const j of c.jobs) {
      j.hours = Number(j.hours) || 0;
      j.done = !!j.done;
      j.invoiced = !!j.invoiced;
    }
  }
  return s;
}

/* ---------------- small helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function fmtHours(h) {
  return (Math.round(h * 100) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

function fmtEur(v) {
  return (Math.round(v * 100) / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }) + ' €';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function client(id) {
  return state.clients.find((c) => c.id === id);
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------------- persistence ---------------- */

function commit({ push = true } = {}) {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    toast('Warning: local storage is full — connect GitHub sync in Settings.');
  }
  render();
  if (push) schedulePush();
}

function schedulePush() {
  if (!cfg.token) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushBoard().catch(showSyncError), 2500);
}

/* ---------------- IndexedDB image cache ---------------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('aem-board', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(id, blob) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('images').objectStore('images').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

/* ---------------- GitHub API ---------------- */

function ghUrl(path) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(path) {
  const res = await fetch(ghUrl(path), { headers: ghHeaders(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

async function ghPut(path, base64, message, sha) {
  const body = { message, content: base64, branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path}: ${res.status}`);
  return res.json();
}

function b64EncodeUtf8(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

function b64DecodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function setSyncStatus(text, kind) {
  const el = $('#syncStatus');
  el.textContent = text;
  el.className = 'sync-status' + (kind ? ' ' + kind : '');
}

function showSyncError(err) {
  console.error(err);
  setSyncStatus('Sync error', 'err');
  toast('GitHub sync failed: ' + err.message);
}

/** Pull remote board; adopt it if it is newer than local. */
async function pullBoard() {
  let remote = null;
  if (cfg.token) {
    const file = await ghGet('data/board.json');
    if (file) remote = JSON.parse(b64DecodeUtf8(file.content));
  } else if (location.protocol !== 'file:') {
    // No token: fall back to the copy sitting next to the app. Skipped when the
    // page was opened straight off disk, where fetch is blocked by CORS anyway.
    try {
      const res = await fetch('data/board.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) remote = await res.json();
    } catch { /* offline or not served — local only */ }
  }
  if (remote && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
    state = normalizeState(remote);
    if (!client(activeClientId)) activeClientId = state.clients[0]?.id || null;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    render();
  }
}

/** Push board.json (and any pending images) to GitHub. Retries once on SHA conflict. */
async function pushBoard() {
  if (!cfg.token || syncing) return;
  syncing = true;
  setSyncStatus('Syncing…', 'busy');
  try {
    await uploadPendingImages();
    const content = b64EncodeUtf8(JSON.stringify(state, null, 2));
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await ghGet('data/board.json');
      try {
        await ghPut('data/board.json', content, 'Update board', existing ? existing.sha : undefined);
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    setSyncStatus('Synced', 'ok');
  } finally {
    syncing = false;
  }
}

async function uploadPendingImages() {
  for (const c of state.clients) {
    for (const img of c.images) {
      if (!img.uploaded) {
        const blob = await idbGet(img.id);
        if (!blob) continue; // cache lost before upload; card will show as pending
        const existing = await ghGet(img.path);
        await ghPut(img.path, await blobToBase64(blob),
          `Add screenshot for ${c.name}`, existing ? existing.sha : undefined);
        img.uploaded = true;
        pendingUploads.delete(img.id);
      }
    }
  }
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

async function fullSync() {
  if (!cfg.token) {
    openModal('settingsModal');
    toast('Add a GitHub token first — the board is saving to this browser only.');
    return;
  }
  try {
    setSyncStatus('Syncing…', 'busy');
    await pullBoard();
    await pushBoard();
    toast('Board synced with GitHub.');
  } catch (err) {
    showSyncError(err);
  }
}

/* ---------------- image resolution ---------------- */

async function resolveImageURL(img) {
  if (objectURLs.has(img.id)) return objectURLs.get(img.id);
  let blob = await idbGet(img.id).catch(() => null);
  if (!blob) {
    try {
      if (cfg.token) {
        const file = await ghGet(img.path);
        if (file && file.content) {
          const bin = atob(file.content.replace(/\n/g, ''));
          blob = new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: 'image/png' });
        }
      } else {
        const res = await fetch(img.path);
        if (res.ok) blob = await res.blob();
      }
      if (blob) await idbPut(img.id, blob);
    } catch { /* leave placeholder */ }
  }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectURLs.set(img.id, url);
  return url;
}

/* ---------------- rendering ---------------- */

function jobRowHtml(c, j) {
  return `
    <li class="job ${j.done ? 'done' : ''}" draggable="true" data-client="${c.id}" data-job="${j.id}">
      <input type="checkbox" ${j.done ? 'checked' : ''} data-act="toggle" title="Mark done">
      <span class="job-text" data-act="edit" title="Click to edit">${esc(j.text)}</span>
      ${j.invoiced ? '<span class="badge-invoiced">invoiced</span>' : ''}
      <input class="job-hours" type="number" min="0" step="0.5" value="${j.hours || ''}"
             placeholder="h" data-act="hours" title="Hours spent">
      <span class="job-hours-label">h</span>
      <button class="job-del" data-act="del" title="Delete job">&#10005;</button>
    </li>`;
}

function cardHtml(c, img) {
  return `
    <div class="card" data-client="${c.id}" data-image="${img.id}" title="${esc(img.caption || 'Click to enlarge')}">
      <img data-imgslot="${img.id}" alt="${esc(img.caption || 'Screenshot')}">
      ${img.uploaded ? '' : '<span class="card-pending" title="Not yet uploaded to GitHub">local</span>'}
      <button class="card-del" data-act="delimg" title="Delete image">&#10005;</button>
      ${img.caption ? `<div class="card-caption">${esc(img.caption)}</div>` : ''}
    </div>`;
}

function columnStats(c) {
  const open = c.jobs.filter((j) => !j.done);
  const doneUnbilled = c.jobs.filter((j) => j.done && !j.invoiced);
  const hours = doneUnbilled.reduce((s, j) => s + j.hours, 0);
  return { openCount: open.length, doneCount: doneUnbilled.length, hours, owed: hours * c.rate };
}

function render() {
  const board = $('#board');
  board.innerHTML = state.clients.map((c) => {
    const s = columnStats(c);
    const lay = layout[c.id] || {};
    return `
    <section class="column ${c.id === activeClientId ? 'active' : ''} ${lay.collapsed ? 'collapsed' : ''}"
             data-client="${c.id}">
      <div class="win-head" data-act="drag">
        <span class="win-title">${esc(c.name)}</span>
        <span class="paste-flag">paste here</span>
        <span class="win-spacer"></span>
        <label class="rate">rate
          <input type="number" min="0" step="1" value="${c.rate || ''}" placeholder="0" data-act="rate"> €/h
        </label>
        <button class="win-btn" data-act="collapse" type="button"
                title="${lay.collapsed ? 'Expand' : 'Collapse'} this window">${lay.collapsed ? '&#9633;' : '&#8722;'}</button>
      </div>
      <div class="win-body">
        <div class="col-stats">
          <span class="stat">open <b>${s.openCount}</b></span>
          <span class="stat">done, not invoiced <b>${s.doneCount}</b></span>
          <span class="stat">hours <b>${fmtHours(s.hours)}</b></span>
          <span class="stat owed">owed <b>${fmtEur(s.owed)}</b></span>
        </div>
        <div class="scroll-area">
          <ul class="jobs" data-client="${c.id}">
            ${c.jobs.map((j) => jobRowHtml(c, j)).join('')}
          </ul>
          ${c.images.length ? `<div class="cards">${c.images.map((i) => cardHtml(c, i)).join('')}</div>` : ''}
        </div>
        <form class="add-job" data-client="${c.id}">
          <input type="text" name="text" placeholder="New job for ${esc(c.name)}…" autocomplete="off">
          <input type="number" name="hours" min="0" step="0.5" placeholder="h" title="Hours (optional)">
          <button class="btn btn-accent" type="submit">+ Add</button>
        </form>
      </div>
      <div class="win-grip" data-act="resize" title="Drag to resize"></div>
    </section>`;
  }).join('');

  applyLayout();

  // Fill in image thumbnails asynchronously.
  for (const c of state.clients) {
    for (const img of c.images) {
      resolveImageURL(img).then((url) => {
        const el = document.querySelector(`img[data-imgslot="${img.id}"]`);
        if (el && url) el.src = url;
      });
    }
  }
}

/* ---------------- floating windows ---------------- */

function stacked() {
  return window.innerWidth < STACK_BELOW;
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* non-fatal */ }
}

/** Geometry for a tidy grid: as many columns as fit at a comfortable width. */
function tileGrid() {
  const board = $('#board');
  const W = board.clientWidth, H = board.clientHeight;
  const n = state.clients.length;
  const gap = 14;
  const COMFORTABLE = 360;   // below this, job titles start wrapping badly
  const cols = Math.max(1, Math.min(n, Math.floor((W - gap) / (COMFORTABLE + gap)) || 1));
  const rows = Math.ceil(n / cols);
  const w = Math.max(MIN_W, Math.floor((W - gap * (cols + 1)) / cols));
  const h = Math.max(MIN_H, Math.min(560, Math.floor((H - gap * (rows + 1)) / rows)));
  return { gap, cols, w, h };
}

function tilePos(i, g) {
  return {
    x: g.gap + (i % g.cols) * (g.w + g.gap),
    y: g.gap + Math.floor(i / g.cols) * (g.h + g.gap),
  };
}

/** Lay the windows back out in a tidy grid. */
function tidy() {
  const g = tileGrid();
  state.clients.forEach((c, i) => {
    const p = tilePos(i, g);
    layout[c.id] = { x: p.x, y: p.y, w: g.w, h: g.h, z: 10 + i, collapsed: false };
  });
  topZ = 10 + state.clients.length;
  saveLayout();
  render();
}

/** Push the stored geometry onto the DOM, filling in anything missing. */
function applyLayout() {
  const board = $('#board');
  board.classList.toggle('stacked', stacked());
  if (stacked()) return;

  const W = board.clientWidth, H = board.clientHeight;
  const g = tileGrid();
  const gap = g.gap;

  state.clients.forEach((c, i) => {
    const el = board.querySelector(`.column[data-client="${c.id}"]`);
    if (!el) return;
    let lay = layout[c.id];
    if (!lay) {
      const p = tilePos(i, g);
      lay = { x: p.x, y: p.y, w: g.w, h: g.h, z: 10 + i, collapsed: false };
      layout[c.id] = lay;
    }
    lay.w = Math.max(MIN_W, Math.min(lay.w || g.w, Math.max(MIN_W, W - 2 * gap)));
    lay.h = Math.max(MIN_H, lay.h || g.h);
    // Keep every window reachable: at least a corner stays inside the desktop.
    lay.x = Math.max(0, Math.min(lay.x, Math.max(0, W - 120)));
    lay.y = Math.max(0, Math.min(lay.y, Math.max(0, H - 44)));

    el.style.left = lay.x + 'px';
    el.style.top = lay.y + 'px';
    el.style.width = lay.w + 'px';
    if (!lay.collapsed) el.style.height = lay.h + 'px';
    el.style.zIndex = lay.z || 10;
    topZ = Math.max(topZ, lay.z || 10);
  });
  saveLayout();
}

function bringToFront(clientId) {
  const lay = layout[clientId];
  if (!lay || lay.z === topZ) return;
  lay.z = ++topZ;
  const el = $(`.column[data-client="${clientId}"]`);
  if (el) el.style.zIndex = lay.z;
  saveLayout();
}

function toggleCollapse(clientId) {
  const lay = layout[clientId];
  if (!lay) return;
  lay.collapsed = !lay.collapsed;
  saveLayout();
  render();
}

/** Pointer-driven move and resize. One handler serves both. */
function startWindowDrag(e) {
  if (stacked() || e.button !== 0) return;
  const handle = e.target.closest('[data-act="drag"], [data-act="resize"]');
  if (!handle) return;
  // Controls that live inside the title bar keep their own behaviour.
  if (e.target.closest('input, button')) return;

  const el = handle.closest('.column');
  const id = el.dataset.client;
  const lay = layout[id];
  if (!lay) return;

  const mode = handle.dataset.act;      // 'drag' | 'resize'
  const board = $('#board');
  const startX = e.clientX, startY = e.clientY;
  const orig = { x: lay.x, y: lay.y, w: lay.w, h: lay.h };

  activeColumn(id);
  bringToFront(id);
  el.classList.add('dragging-window');
  handle.setPointerCapture(e.pointerId);
  e.preventDefault();

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (mode === 'drag') {
      lay.x = Math.max(0, Math.min(orig.x + dx, Math.max(0, board.clientWidth - 120)));
      lay.y = Math.max(0, Math.min(orig.y + dy, Math.max(0, board.clientHeight - 44)));
      el.style.left = lay.x + 'px';
      el.style.top = lay.y + 'px';
    } else {
      lay.w = Math.max(MIN_W, Math.min(orig.w + dx, board.clientWidth - lay.x));
      lay.h = Math.max(MIN_H, Math.min(orig.h + dy, board.clientHeight - lay.y));
      el.style.width = lay.w + 'px';
      el.style.height = lay.h + 'px';
    }
  };

  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    el.classList.remove('dragging-window');
    saveLayout();
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

/* ---------------- board interactions ---------------- */

function onBoardClick(e) {
  const colEl = e.target.closest('.column');
  if (colEl) {
    activeColumn(colEl.dataset.client);
    bringToFront(colEl.dataset.client);
  }

  const jobEl = e.target.closest('.job');
  const act = e.target.dataset.act;

  if (act === 'collapse') {
    toggleCollapse(colEl.dataset.client);
    return;
  }

  if (jobEl && act === 'toggle') {
    const j = client(jobEl.dataset.client).jobs.find((x) => x.id === jobEl.dataset.job);
    j.done = e.target.checked;
    j.doneAt = j.done ? Date.now() : null;
    if (!j.done) j.invoiced = false;
    commit();
    return;
  }
  if (jobEl && act === 'del') {
    const c = client(jobEl.dataset.client);
    const j = c.jobs.find((x) => x.id === jobEl.dataset.job);
    if (confirm(`Delete job "${j.text}"?`)) {
      c.jobs = c.jobs.filter((x) => x.id !== j.id);
      commit();
    }
    return;
  }
  if (jobEl && act === 'edit') {
    startEditJob(jobEl);
    return;
  }
  if (act === 'delimg') {
    e.stopPropagation();
    const cardEl = e.target.closest('.card');
    deleteImage(cardEl.dataset.client, cardEl.dataset.image);
    return;
  }
  const cardEl = e.target.closest('.card');
  if (cardEl) openLightbox(cardEl.dataset.client, cardEl.dataset.image);
}

function activeColumn(id) {
  if (id === activeClientId) return;
  activeClientId = id;
  document.querySelectorAll('.column').forEach((el) =>
    el.classList.toggle('active', el.dataset.client === id));
}

function onBoardChange(e) {
  const act = e.target.dataset.act;
  if (act === 'rate') {
    const c = client(e.target.closest('.column').dataset.client);
    c.rate = Number(e.target.value) || 0;
    commit();
  }
  if (act === 'hours') {
    const jobEl = e.target.closest('.job');
    const j = client(jobEl.dataset.client).jobs.find((x) => x.id === jobEl.dataset.job);
    j.hours = Number(e.target.value) || 0;
    commit();
  }
}

function startEditJob(jobEl) {
  const c = client(jobEl.dataset.client);
  const j = c.jobs.find((x) => x.id === jobEl.dataset.job);
  const span = jobEl.querySelector('.job-text');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'job-text-input';
  input.value = j.text;
  span.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const done = () => {
    const v = input.value.trim();
    if (v && v !== j.text) { j.text = v; commit(); }
    else render();
  };
  input.addEventListener('blur', done);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') input.blur();
    if (ev.key === 'Escape') { input.value = j.text; input.blur(); }
  });
}

function onAddJob(e) {
  e.preventDefault();
  const form = e.target;
  const text = form.text.value.trim();
  if (!text) return;
  const c = client(form.dataset.client);
  c.jobs.push({
    id: uid(),
    text,
    hours: Number(form.hours.value) || 0,
    done: false,
    invoiced: false,
    createdAt: Date.now(),
    doneAt: null,
  });
  commit();
  // Keep typing flow: refocus the same column's new-job input after re-render.
  const next = document.querySelector(`.add-job[data-client="${c.id}"] input[name="text"]`);
  if (next) next.focus();
}

/* ---------------- drag & drop (jobs + image files) ---------------- */

function onDragStart(e) {
  const jobEl = e.target.closest('.job');
  if (!jobEl) return;
  dragRef = { clientId: jobEl.dataset.client, jobId: jobEl.dataset.job };
  jobEl.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', jobEl.dataset.job);
}

function onDragEnd() {
  dragRef = null;
  document.querySelectorAll('.job.dragging, .job.droptarget').forEach((el) =>
    el.classList.remove('dragging', 'droptarget'));
  document.querySelectorAll('.column.dragover').forEach((el) => el.classList.remove('dragover'));
}

function onDragOver(e) {
  const colEl = e.target.closest('.column');
  if (!colEl) return;
  e.preventDefault(); // allow drop (both job moves and image files)
  document.querySelectorAll('.job.droptarget').forEach((el) => el.classList.remove('droptarget'));
  if (dragRef) {
    const jobEl = e.target.closest('.job');
    if (jobEl && jobEl.dataset.job !== dragRef.jobId) jobEl.classList.add('droptarget');
  } else {
    colEl.classList.add('dragover'); // external file drag
  }
}

function onDrop(e) {
  const colEl = e.target.closest('.column');
  if (!colEl) return;
  e.preventDefault();

  // Image files dropped from the OS.
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!dragRef && files.length) {
    activeColumn(colEl.dataset.client);
    files.forEach((f) => addImage(colEl.dataset.client, f));
    onDragEnd();
    return;
  }
  if (!dragRef) { onDragEnd(); return; }

  // Job reorder / move between clients.
  const from = client(dragRef.clientId);
  const job = from.jobs.find((j) => j.id === dragRef.jobId);
  if (!job) { onDragEnd(); return; }
  from.jobs = from.jobs.filter((j) => j.id !== job.id);

  const to = client(colEl.dataset.client);
  const targetEl = e.target.closest('.job');
  if (targetEl && targetEl.dataset.client === to.id) {
    const idx = to.jobs.findIndex((j) => j.id === targetEl.dataset.job);
    to.jobs.splice(idx < 0 ? to.jobs.length : idx, 0, job);
  } else {
    to.jobs.push(job);
  }
  onDragEnd();
  commit();
}

/* ---------------- images: paste / add / delete ---------------- */

function onPaste(e) {
  // Let a normal text paste into a field work untouched. The target is not always
  // an Element (it can be the document itself when nothing has focus).
  const t = e.target;
  if (t instanceof Element && t.matches('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  if (!activeClientId) { toast('Click a client column first, then paste.'); return; }
  addImage(activeClientId, item.getAsFile());
}

async function addImage(clientId, blob) {
  const c = client(clientId);
  const id = uid();
  const img = {
    id,
    path: `data/img/${id}.png`,
    caption: '',
    uploaded: false,
    createdAt: Date.now(),
  };
  try { await idbPut(id, blob); } catch { toast('Could not cache image locally.'); }
  pendingUploads.add(id);
  c.images.push(img);
  commit();
  toast(`Screenshot added to ${c.name}${cfg.token ? '' : ' (local only — set up GitHub sync to share it)'}.`);
}

async function deleteImage(clientId, imageId) {
  if (!confirm('Delete this image?')) return;
  const c = client(clientId);
  c.images = c.images.filter((i) => i.id !== imageId);
  await idbDelete(imageId);
  if (objectURLs.has(imageId)) {
    URL.revokeObjectURL(objectURLs.get(imageId));
    objectURLs.delete(imageId);
  }
  // Note: the file stays in git history on GitHub; the board simply no longer shows it.
  commit();
}

/* ---------------- lightbox ---------------- */

async function openLightbox(clientId, imageId) {
  const img = client(clientId).images.find((i) => i.id === imageId);
  if (!img) return;
  lightboxRef = { clientId, imageId };
  $('#lightboxCaption').value = img.caption || '';
  $('#lightboxImg').src = (await resolveImageURL(img)) || '';
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox(save = true) {
  if (save && lightboxRef) {
    const img = client(lightboxRef.clientId)?.images.find((i) => i.id === lightboxRef.imageId);
    const v = $('#lightboxCaption').value.trim();
    if (img && img.caption !== v) { img.caption = v; commit(); }
  }
  lightboxRef = null;
  $('#lightbox').classList.add('hidden');
}

/* ---------------- billing ---------------- */

function billingRows() {
  const cid = $('#billingClient').value;
  const filter = $('#billingFilter').value;
  const clients = cid === 'all' ? state.clients : [client(cid)];
  const rows = [];
  for (const c of clients) {
    for (const j of c.jobs) {
      if (!j.done) continue;
      if (filter === 'open' && j.invoiced) continue;
      rows.push({ client: c, job: j });
    }
  }
  rows.sort((a, b) => (a.job.doneAt || 0) - (b.job.doneAt || 0));
  return rows;
}

function renderBilling() {
  const rows = billingRows();
  const box = $('#billingContent');
  if (!rows.length) {
    box.innerHTML = '<p class="muted">No done jobs match this filter yet.</p>';
    return;
  }
  const totalHours = rows.reduce((s, r) => s + r.job.hours, 0);
  const totalOwed = rows.reduce((s, r) => s + r.job.hours * r.client.rate, 0);
  box.innerHTML = `
    <table class="billing-table">
      <thead><tr>
        <th>Done</th><th>Client</th><th>Job</th>
        <th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${fmtDate(r.job.doneAt)}</td>
            <td>${esc(r.client.name)}</td>
            <td>${esc(r.job.text)}${r.job.invoiced ? ' <span class="badge-invoiced">invoiced</span>' : ''}</td>
            <td class="num">${fmtHours(r.job.hours)}</td>
            <td class="num">${fmtEur(r.client.rate)}</td>
            <td class="num">${fmtEur(r.job.hours * r.client.rate)}</td>
          </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr class="billing-total">
          <td colspan="3">Total</td>
          <td class="num">${fmtHours(totalHours)}</td>
          <td></td>
          <td class="num owed">${fmtEur(totalOwed)}</td>
        </tr>
      </tfoot>
    </table>`;
}

function openBilling() {
  const sel = $('#billingClient');
  sel.innerHTML = '<option value="all">All clients</option>' +
    state.clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (activeClientId) sel.value = activeClientId;
  renderBilling();
  openModal('billingModal');
}

function copyReport() {
  const rows = billingRows();
  const lines = ['AEM Baltic — work report ' + fmtDate(Date.now()), ''];
  let totalHours = 0, totalOwed = 0;
  for (const r of rows) {
    totalHours += r.job.hours;
    totalOwed += r.job.hours * r.client.rate;
    lines.push(`${fmtDate(r.job.doneAt)}  ${r.client.name}  ${r.job.text}  ${fmtHours(r.job.hours)} h  ${fmtEur(r.job.hours * r.client.rate)}`);
  }
  lines.push('', `TOTAL: ${fmtHours(totalHours)} h — ${fmtEur(totalOwed)}`);
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => toast('Report copied to clipboard.'))
    .catch(() => toast('Could not copy — your browser blocked clipboard access.'));
}

function markInvoiced() {
  const rows = billingRows().filter((r) => !r.job.invoiced);
  if (!rows.length) { toast('Nothing new to mark as invoiced.'); return; }
  if (!confirm(`Mark ${rows.length} job(s) as invoiced? They stay in history but drop out of the "owed" totals.`)) return;
  rows.forEach((r) => { r.job.invoiced = true; });
  commit();
  renderBilling();
}

/* ---------------- settings ---------------- */

function openSettings() {
  $('#cfgOwner').value = cfg.owner;
  $('#cfgRepo').value = cfg.repo;
  $('#cfgBranch').value = cfg.branch;
  $('#cfgToken').value = cfg.token;
  $('#cfgTestResult').textContent = '';
  openModal('settingsModal');
}

function readCfgForm() {
  return {
    owner: $('#cfgOwner').value.trim() || defaultCfg.owner,
    repo: $('#cfgRepo').value.trim() || defaultCfg.repo,
    branch: $('#cfgBranch').value.trim() || defaultCfg.branch,
    token: $('#cfgToken').value.trim(),
  };
}

async function testCfg() {
  const tmp = readCfgForm();
  const out = $('#cfgTestResult');
  out.textContent = 'Testing…';
  try {
    const res = await fetch(`https://api.github.com/repos/${tmp.owner}/${tmp.repo}/branches/${encodeURIComponent(tmp.branch)}`, {
      headers: { Authorization: `Bearer ${tmp.token}`, Accept: 'application/vnd.github+json' },
    });
    out.textContent = res.ok
      ? '✓ Connected — repository and branch found.'
      : `✗ GitHub answered ${res.status}. Check owner/repo/branch and the token's permissions.`;
  } catch (e) {
    out.textContent = '✗ Network error: ' + e.message;
  }
}

function saveCfg() {
  cfg = readCfgForm();
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  closeModal('settingsModal');
  if (cfg.token) {
    setSyncStatus('Connecting…', 'busy');
    fullSync();
  } else {
    setSyncStatus('Local only');
  }
}

/* ---------------- modals ---------------- */

function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }

/* ---------------- wiring ---------------- */

/** Use the real logo file if one has been committed, otherwise set the wordmark. */
function initBrand() {
  const img = $('#brandLogo');
  const text = $('#brandText');
  const candidates = ['assets/logo.svg', 'assets/logo.png', 'assets/logo.webp'];
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) { img.remove(); text.hidden = false; return; }
    img.src = candidates[i++];
  };
  img.addEventListener('error', tryNext);
  tryNext();
}

function init() {
  initBrand();
  render();

  const board = $('#board');
  board.addEventListener('pointerdown', startWindowDrag);
  board.addEventListener('click', onBoardClick);
  board.addEventListener('change', onBoardChange);
  board.addEventListener('submit', onAddJob);
  board.addEventListener('dragstart', onDragStart);
  board.addEventListener('dragend', onDragEnd);
  board.addEventListener('dragover', onDragOver);
  board.addEventListener('drop', onDrop);

  document.addEventListener('paste', onPaste);

  $('#btnTidy').addEventListener('click', tidy);
  $('#btnSync').addEventListener('click', fullSync);

  // Re-clamp windows so none is stranded off-screen after a resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyLayout, 150);
  });
  $('#btnBilling').addEventListener('click', openBilling);
  $('#btnSettings').addEventListener('click', openSettings);

  $('#billingClient').addEventListener('change', renderBilling);
  $('#billingFilter').addEventListener('change', renderBilling);
  $('#btnCopyReport').addEventListener('click', copyReport);
  $('#btnMarkInvoiced').addEventListener('click', markInvoiced);

  $('#btnTestCfg').addEventListener('click', testCfg);
  $('#btnSaveCfg').addEventListener('click', saveCfg);

  $('#lightboxClose').addEventListener('click', () => closeLightbox());
  $('#lightboxCaption').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeLightbox(); });
  $('#lightboxDelete').addEventListener('click', () => {
    const ref = lightboxRef;
    closeLightbox(false);
    if (ref) deleteImage(ref.clientId, ref.imageId);
  });
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
      closeModal('billingModal');
      closeModal('settingsModal');
    }
  });

  if (cfg.token) {
    setSyncStatus('Connecting…', 'busy');
    pullBoard().then(() => pushBoard()).then(() => setSyncStatus('Synced', 'ok')).catch(showSyncError);
  } else {
    pullBoard().catch(() => {}); // best-effort read of the hosted copy
  }
}

init();
