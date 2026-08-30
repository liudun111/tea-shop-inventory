/* ============================================================
   茶店进销存 · 主逻辑
   功能：商品管理（含图片）· 进货 · 销售开单 · 库存流水 · 报表 · 备份
   ============================================================ */
'use strict';

/* ---------------- 工具函数 ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => '¥' + round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = n => {
  const r = round2(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};
const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const pad2 = n => String(n).padStart(2, '0');
const dateTimeStr = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, fn) => arr.reduce((s, x) => s + (fn(x) || 0), 0);
const inRange = (m, from, to) => (!from || m.date >= from) && (!to || m.date <= to);
const weekdayText = () => '星期' + '日一二三四五六'[new Date().getDay()];
const download = (filename, text) => {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
};

/* ---------------- 全局错误捕获 ---------------- */
window.addEventListener('error', e => {
  try { console.error(e.error || e); } catch (_) { /* 忽略 */ }
  try { toast('出错了：' + (e.error && e.error.message ? e.error.message : (e.message || '未知错误')), 'error', 5000); } catch (_) { /* 忽略 */ }
});
window.addEventListener('unhandledrejection', e => {
  try { console.error(e.reason); } catch (_) { /* 忽略 */ }
  try { toast('出错了：' + (e.reason && e.reason.message ? e.reason.message : String(e.reason || '未知错误')), 'error', 5000); } catch (_) { /* 忽略 */ }
});

/* ---------------- 常量 ---------------- */
const CATEGORIES = ['茶叶', '礼盒', '罐子', '茶具', '其他'];
const CAT_ICON = { '茶叶': '🍃', '礼盒': '🎁', '罐子': '🏺', '茶具': '🫖', '其他': '📦' };
const CAT_STYLE = {
  '茶叶': { bg: '#E4F1E9', fg: '#2F6B4F' },
  '礼盒': { bg: '#FBF0D9', fg: '#9A7B1E' },
  '罐子': { bg: '#E5EDF7', fg: '#2C5E9E' },
  '茶具': { bg: '#F4E9E3', fg: '#9A5B33' },
  '其他': { bg: '#EFEDE7', fg: '#6B6455' },
};
const TYPE_META = {
  in:     { label: '进货', cls: 't-in' },
  out:    { label: '销售', cls: 't-out' },
  adjust: { label: '调整', cls: 't-adjust' },
};
const DEFAULT_SETTINGS = { shopName: '茶语轩', lowStock: 10, allowNegative: false };

/* 产品 ID：按分类前缀 + 序号自动生成，一看前缀就知道类别 */
const CAT_PREFIX = { '茶叶': 'CY', '礼盒': 'LH', '罐子': 'GZ', '茶具': 'CJ', '其他': 'QT' };
function genProductId(category) {
  const prefix = CAT_PREFIX[category] || 'QT';
  let max = 0;
  state.products.forEach(p => {
    if (p.id && p.id.startsWith(prefix)) {
      const n = parseInt(p.id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(4, '0');
}

const ICONS = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  in:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

/* ---------------- 状态 ---------------- */
const state = {
  products: [],
  movements: [],
  settings: Object.assign({}, DEFAULT_SETTINGS),
  stock: new Map(),
  view: 'dashboard',
  filters: { q: '', cat: '全部', low: false, show: 'online' },
  objUrls: new Map(),
  logo: null,
  logoUrl: null,
  logoPath: null,           // 磁盘模式下 Logo 的独立文件路径（images/xxx）
  imageDataUrls: new Map(),  // 兼容旧数据：base64 缓存（新格式不再使用）
  logoDataUrl: null,
  reportPeriod: 'month',
};

/* ---------------- 数据存取 ---------------- */
async function loadSettings() {
  const row = await db.get('settings', 'main');
  state.settings = Object.assign({}, DEFAULT_SETTINGS, row ? row.value : {});
  const logoRow = await db.get('settings', 'logo');
  state.logo = logoRow ? logoRow.value : null;
}
async function saveSettings(partial) {
  state.settings = Object.assign({}, state.settings, partial);
  await db.put('settings', { key: 'main', value: state.settings });
  $('#brandName').textContent = state.settings.shopName || '茶语轩';
  document.title = `${state.settings.shopName || '茶语轩'} · 进销存管理`;
  await persistOp('settings', { settings: state.settings, logoPath: state.logoPath });
}
async function loadAll() {
  state.products = (await db.getAll('products')) || [];
  state.movements = (await db.getAll('movements')) || [];
  recomputeStock();
}

/* ---------------- 磁盘存储（本地服务器，需通过 start.bat 启动） ---------------- */
const storage = {
  mode: 'browser', // 'disk' = 本地服务器（SQLite/JSON） | 'browser' = 浏览器临时存储（兜底）
  backend: 'json', // 'sqlite' | 'json'

  async detect() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch('api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        if (j && j.storage === 'disk') {
          this.mode = 'disk';
          if (j.backend) this.backend = j.backend;
        }
      }
    } catch (e) { /* 非服务器环境（如直接双击 index.html 打开） */ }
  },

  async load() {
    try {
      const r = await fetch('api/data', { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return (j && Array.isArray(j.products) && Array.isArray(j.movements)) ? j : null;
    } catch (e) { return null; }
  },

  /** 逐操作写入：每个操作在服务器端一个事务内完成（库存+流水同事务） */
  async op(op, data) {
    try {
      const r = await fetch('api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, data }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j && j.error ? j.error : '操作失败');
      return true;
    } catch (e) { return false; }
  },
};

/** 上传图片到服务器 images/ 目录，返回相对路径（如 images/xxx.jpg）；失败返回 null */
async function uploadImage(blob) {
  try {
    const r = await fetch('api/image', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.path ? j.path : null;
  } catch (e) { return null; }
}

/** 按相对路径（images/xxx）从服务器取图片为 Blob；失败返回 null */
async function fetchImage(relPath) {
  try {
    const r = await fetch(relPath, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.blob();
  } catch (e) { return null; }
}

/** 把商品列表序列化为可发给服务器的 JSON（图片上传为独立文件，剔除 Blob） */
async function serializeProducts(products) {
  const out = [];
  for (const p of products) {
    const c = Object.assign({}, p);
    if (c.imageBlob && !c.imagePath) {
      // 新上传/尚未有路径的图片 → 上传为独立文件并回写，避免重复上传
      const pth = await uploadImage(c.imageBlob);
      if (pth) { c.imagePath = pth; p.imagePath = pth; }
    }
    delete c.imageBlob;
    out.push(c);
  }
  return out;
}

/** 磁盘模式下把一次业务操作持久化到服务器；失败时提示并刷新以保持同步 */
async function persistOp(op, data) {
  if (storage.mode !== 'disk') return true; // 浏览器模式由 IndexedDB 持久化
  const ok = await storage.op(op, data);
  if (!ok) {
    toast('保存到服务器失败，正在刷新以同步数据…', 'error', 3000);
    setTimeout(() => location.reload(), 1200);
  }
  return ok;
}

/** 从磁盘文件数据恢复内存状态（兼容新格式 imagePath 与旧格式 imageDataUrl） */
async function hydrateFromDisk(disk) {
  const products = [];
  for (const p of disk.products) {
    const c = Object.assign({}, p);
    if (c.imagePath) {
      c.imageBlob = await fetchImage(c.imagePath);
    } else if (c.imageDataUrl) { // 兼容未迁移的旧格式
      c.imageBlob = await dataURLToBlob(c.imageDataUrl);
      delete c.imageDataUrl;
    }
    products.push(c);
  }
  state.products = products;
  state.movements = Array.isArray(disk.movements) ? disk.movements : [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS, disk.settings || {});
  state.logoPath = disk.logoPath || null;
  if (disk.logoPath) {
    state.logo = await fetchImage(disk.logoPath);
  } else if (disk.logoDataUrl) { // 兼容旧格式
    state.logo = await dataURLToBlob(disk.logoDataUrl);
  }
  state.imageDataUrls = new Map();
  state.logoDataUrl = null;
  recomputeStock();
}

async function loadFromIDB() {
  if (!db._db) return; // 浏览器存储不可用时直接跳过（磁盘模式不受影响）
  await loadAll();
  await loadSettings();
}

/* ---------------- 库存计算 ---------------- */
function recomputeStock() {
  const map = new Map();
  state.products.forEach(p => map.set(p.id, 0));
  state.movements.forEach(m => {
    const cur = map.get(m.productId) || 0;
    map.set(m.productId, cur + (m.type === 'out' ? -m.quantity : m.quantity));
  });
  state.stock = map;
}
const stockOf = id => state.stock.get(id) || 0;
const productById = id => state.products.find(p => p.id === id);
const stockValue = () => sum(state.products, p => stockOf(p.id) * (p.purchasePrice || 0));
const lowThreshold = p => (p.lowStock != null && p.lowStock !== '' ? Number(p.lowStock) : Number(state.settings.lowStock) || 0);
const isLowStock = p => {
  const s = stockOf(p.id);
  const t = lowThreshold(p);
  return t > 0 ? s <= t : s <= 0;
};
const sortedMovements = () =>
  [...state.movements].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

/* ---------------- 图片处理 ---------------- */
function imageUrl(p) {
  if (!p || !p.imageBlob) return '';
  let u = state.objUrls.get(p.id);
  if (!u) {
    u = URL.createObjectURL(p.imageBlob);
    state.objUrls.set(p.id, u);
  }
  return u;
}
function revokeImage(p) {
  const u = state.objUrls.get(p.id);
  if (u) { URL.revokeObjectURL(u); state.objUrls.delete(p.id); }
  state.imageDataUrls.delete(p.id);
}
function placeHolder(p) {
  return `<div class="ph">${(p && CAT_ICON[p.category]) || '🍵'}</div>`;
}
function imgHtml(p, cls) {
  const url = imageUrl(p);
  return url ? `<img src="${url}" alt="${esc(p ? p.name : '')}">` : placeHolder(p);
}
function processImage(file, maxDim = 1200) {
  return new Promise(resolve => {
    if (!file || !file.type.startsWith('image/')) { resolve(null); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      if (scale < 1) { w = Math.round(w * scale); h = Math.round(h * scale); }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => { URL.revokeObjectURL(url); resolve(b); }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
function blobToDataURL(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(dataUrl) {
  try {
    const r = await fetch(dataUrl);
    return await r.blob();
  } catch (e) { return null; }
}

/* ---------------- UI 基础组件 ---------------- */
function toast(msg, type = 'success', ms = 2600) {
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${esc(msg)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function openModal(html, opts = {}) {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal ${opts.wide ? 'modal-wide' : ''} ${opts.sm ? 'modal-sm' : ''} ${opts.cls || ''}">${html}</div>`;
  $('#modalHost').appendChild(el);
  const close = () => { if (opts.dismissible !== false) el.remove(); };
  el.addEventListener('click', e => {
    if (e.target === el) close();
    else if (e.target.closest('[data-close]')) close();
  });
  if (opts.dismissible !== false) {
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }
  return el;
}

function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-x" data-act="cancel">✕</button></div>
        <div class="modal-body"><p class="confirm-msg">${message}</p></div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    $('#modalHost').appendChild(el);
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act) done(act.dataset.act === 'ok');
      else if (e.target === el) done(false);
    });
    document.addEventListener('keydown', function h(ev) {
      if (ev.key === 'Escape') { document.removeEventListener('keydown', h); done(false); }
    });
  });
}

/* 选项 HTML */
function productOptions(selectedId, includeHidden) {
  const list = state.products.filter(p => includeHidden || !p.hidden);
  if (!list.length) {
    return '<option value="" disabled selected>' +
      (state.products.length ? '没有可选的在线商品（可在「商品管理 → 隐藏商品」中查看）' : '请先在「商品管理」中添加商品') +
      '</option>';
  }
  return list.map(p =>
    `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}${p.spec ? '（' + esc(p.spec) + '）' : ''} · ${esc(p.category || '')} · ${esc(p.id || '')}${p.hidden ? '（已隐藏）' : ''}</option>`
  ).join('');
}
function categoryOptions(sel) {
  return CATEGORIES.map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
}
function badgeHtml(text, cat) {
  const st = CAT_STYLE[cat] || CAT_STYLE['其他'];
  return `<span class="badge" style="background:${st.bg};color:${st.fg}">${esc(text)}</span>`;
}

/* ---------------- 视图切换 ---------------- */
const VIEW_META = {
  dashboard: { title: '首页', sub: () => `${todayStr()} ${weekdayText()} · ${state.settings.shopName}经营概览` },
  products:  { title: '商品管理', sub: () => {
    const online = state.products.filter(p => !p.hidden).length;
    const hidden = state.products.length - online;
    return `在线 ${online} 种，隐藏 ${hidden} 种，共 ${state.products.length} 种商品`;
  } },
  purchase:  { title: '进货入库', sub: () => '记录采购进货，自动增加库存' },
  sales:     { title: '销售开单', sub: () => '记录销售，自动扣减库存' },
  movements: { title: '库存与流水', sub: () => `当前库存总值 ${money(stockValue())}` },
  reports:   { title: '统计报表', sub: () => '销售与毛利分析，支持导出' },
  settings:  { title: '设置', sub: () => '店铺信息、备份与数据管理' },
};
const VIEW_ACTIONS = {
  dashboard: [
    { label: '记一笔进货', cls: 'btn-ghost', icon: ICONS.in, action: () => openPurchaseModal(null) },
    { label: '新建销售单', cls: 'btn-primary', icon: ICONS.cart, action: openSaleModal },
  ],
  products:  [{ label: '新增商品', cls: 'btn-primary', icon: ICONS.plus, action: () => openProductModal(null) }],
  purchase:  [{ label: '快速进货', cls: 'btn-primary', icon: ICONS.in, action: () => openPurchaseModal(null) }],
  sales:     [{ label: '新建销售单', cls: 'btn-primary', icon: ICONS.cart, action: openSaleModal }],
  movements: [{ label: '库存调整', cls: 'btn-ghost', action: () => openAdjustModal(null) }],
  reports:   [{ label: '导出 CSV', cls: 'btn-ghost', action: exportReportCsv }],
  settings:  [],
};

function showView(route) {
  state.view = route;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === route));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + route));
  const meta = VIEW_META[route] || VIEW_META.dashboard;
  $('#viewTitle').textContent = meta.title;
  $('#viewSub').textContent = meta.sub();
  const host = $('#topbarActions');
  host.innerHTML = (VIEW_ACTIONS[route] || []).map(a =>
    `<button class="btn ${a.cls} btn-sm" data-act="${esc(a.label)}">${a.icon || ''}${esc(a.label)}</button>`
  ).join('');
  host.querySelectorAll('button').forEach(b => {
    const act = VIEW_ACTIONS[route].find(x => x.label === b.dataset.act);
    if (act) b.addEventListener('click', act.action);
  });
  ({ dashboard: renderDashboard, products: renderProducts, purchase: renderPurchase,
     sales: renderSales, movements: renderMovements, reports: renderReport,
     settings: renderSettings })[route]();
  location.hash = route;
}

function refresh() { showView(state.view); }

/* ---------------- 商品管理 ---------------- */
function renderProducts() {
  const { q, cat, low, show } = state.filters;
  const kw = q.trim().toLowerCase();

  // 在线 / 全部 / 隐藏 范围
  const base = state.products.filter(p => show === 'all' ? true : (show === 'hidden' ? p.hidden : !p.hidden));
  const list = base.filter(p => {
    if (cat !== '全部' && p.category !== cat) return false;
    if (low && !isLowStock(p)) return false;
    if (kw && !(p.name || '').toLowerCase().includes(kw) && !(p.spec || '').toLowerCase().includes(kw) && !(p.id || '').toLowerCase().includes(kw)) return false;
    return true;
  }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));

  // 显示范围分段按钮
  $$('#showSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.show === show));

  // 分类筛选条
  const counts = { '全部': base.length };
  base.forEach(p => { counts[p.category || '其他'] = (counts[p.category || '其他'] || 0) + 1; });
  $('#categoryChips').innerHTML = ['全部', ...CATEGORIES].map(c =>
    `<button class="chip ${cat === c ? 'active' : ''}" data-cat="${c}">${c} <span class="chip-n">${counts[c] || 0}</span></button>`
  ).join('');

  const grid = $('#productGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><span class="empty-icon">🍵</span>${
      !state.products.length ? '还没有商品，点击右上角「新增商品」开始录入'
      : show === 'hidden' ? '还没有隐藏商品'
      : '没有符合条件的商品'
    }</div>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const s = stockOf(p.id);
    const low = isLowStock(p);
    return `
    <div class="p-card" data-id="${p.id}" title="点击编辑">
      <div class="p-img">${imgHtml(p)}</div>
      <div class="p-body">
        <div class="p-name">${esc(p.name)}</div>
        <div class="p-meta">${badgeHtml(p.category || '其他', p.category)}${p.spec ? `<span class="p-spec">${esc(p.spec)}</span>` : ''}<span class="p-id">${esc(p.id || '')}</span></div>
        <div class="p-stock">库存 <b class="${low ? 'low' : ''}">${fmtQty(s)}</b> ${esc(p.unit || '')}${low ? ' <span class="badge" style="background:#FBEAE5;color:#C04A32">不足</span>' : ''}${p.hidden ? ' <span class="badge" style="background:#EFEDE7;color:#6B6455">已隐藏</span>' : ''}</div>
        <div class="p-price"><span class="sale">${money(p.salePrice || 0)}</span><span class="cost">进 ${money(p.purchasePrice || 0)}</span></div>
        <div class="p-actions">
          <button class="row-btn" data-edit="${p.id}">编辑</button>
          <button class="row-btn danger" data-del="${p.id}">删除</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function openProductModal(id) {
  const p = id ? productById(id) : null;
  const el = openModal(`
    <div class="modal-head"><h2>${p ? '编辑商品' : '新增商品'}</h2><button class="modal-x" data-close>✕</button></div>
    <div class="modal-body">
      <div class="img-uploader">
        <div class="img-preview" id="imgPreview">${p ? (imageUrl(p) ? `<img src="${imageUrl(p)}">` : placeHolder(p)) : placeHolder(null)}</div>
        <div class="img-actions">
          <label class="btn btn-ghost btn-sm">📷 上传图片<input type="file" id="imgInput" accept="image/*" hidden></label>
          <button type="button" class="btn btn-ghost btn-sm" id="imgRemove">移除图片</button>
          <span class="hint">支持 JPG / PNG / WebP<br>自动压缩到 1200px 以内</span>
        </div>
      </div>
      ${p ? `<p class="current-stock-line">当前库存：<b>${fmtQty(stockOf(p.id))}</b> ${esc(p.unit || '')}</p>` : ''}
      <form id="productForm" class="form-grid" autocomplete="off">
        <label>产品ID<input id="pId" class="input" value="${esc(p ? p.id : genProductId('茶叶'))}" readonly title="系统自动生成，按分类编号"></label>
        <label><span>商品名称<span class="req">*</span></span><input id="pName" class="input" required value="${esc(p ? p.name : '')}" placeholder="如：武夷山大红袍"></label>
        <label>分类<select id="pCategory" class="select">${categoryOptions(p ? p.category : '茶叶')}</select></label>
        <label>规格<input id="pSpec" class="input" value="${esc(p ? p.spec : '')}" placeholder="如：250克/罐"></label>
        <label>单位<input id="pUnit" class="input" value="${esc(p ? p.unit : '')}" placeholder="如：罐 / 盒 / 斤"></label>
        <label>进货价（¥）<input id="pCost" class="input" type="number" step="0.01" min="0" value="${p && p.purchasePrice ? p.purchasePrice : ''}"></label>
        <label>销售价（¥）<input id="pSale" class="input" type="number" step="0.01" min="0" value="${p && p.salePrice ? p.salePrice : ''}"></label>
        <label>低库存阈值<input id="pLow" class="input" type="number" step="1" min="0" value="${p && p.lowStock != null ? p.lowStock : ''}" placeholder="留空使用全局默认"></label>
        <label class="span2">备注<input id="pNote" class="input" value="${esc(p ? p.note : '')}" placeholder="可选"></label>
        <label class="check span2"><input type="checkbox" id="pHidden" ${p && p.hidden ? 'checked' : ''}><span>隐藏此商品（停售 / 过期商品，不出现在销售与进货选择中，可在「商品管理 → 隐藏商品」中查看）</span></label>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" form="productForm" type="submit">保存</button>
    </div>`, { wide: true });

  let newBlob = p ? p.imageBlob : null;
  let removeImage = false;
  const preview = $('#imgPreview', el);
  // 新建商品：切换分类时自动更新产品ID预览
  if (!p) {
    $('#pCategory', el).addEventListener('change', () => {
      $('#pId', el).value = genProductId($('#pCategory', el).value);
    });
  }
  $('#imgInput', el).addEventListener('change', async () => {
    const f = $('#imgInput', el).files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('图片超过 8MB，请压缩后再上传', 'error'); return; }
    const blob = await processImage(f);
    if (blob) { newBlob = blob; removeImage = false; preview.innerHTML = `<img src="${URL.createObjectURL(blob)}">`; }
  });
  $('#imgRemove', el).addEventListener('click', () => { newBlob = null; removeImage = true; preview.innerHTML = placeHolder(p); });

  $('#productForm', el).addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#pName', el).value.trim();
    if (!name) { toast('请填写商品名称', 'error'); return; }
    const now = new Date().toISOString();
    const obj = {
      id: p ? p.id : $('#pId', el).value,
      name,
      category: $('#pCategory', el).value,
      spec: $('#pSpec', el).value.trim(),
      unit: $('#pUnit', el).value.trim(),
      purchasePrice: round2(parseFloat($('#pCost', el).value) || 0),
      salePrice: round2(parseFloat($('#pSale', el).value) || 0),
      lowStock: $('#pLow', el).value === '' ? null : Number($('#pLow', el).value),
      note: $('#pNote', el).value.trim(),
      hidden: $('#pHidden', el).checked,
      createdAt: p ? p.createdAt : now,
      updatedAt: now,
    };
    if (removeImage) {
      // 用户移除了图片
      obj.imagePath = null;
      obj.imageBlob = null;
    } else {
      if (p && p.imagePath) obj.imagePath = p.imagePath; // 图片未变：沿用已有文件
      if (newBlob) {
        obj.imageBlob = newBlob;
        if (!obj.imagePath) {
          // 新上传的图片 → 上传为独立文件，JSON 只存路径
          const pth = await uploadImage(newBlob);
          if (pth) obj.imagePath = pth;
        }
      }
    }
    if (p) revokeImage(p);

    if (p) {
      const idx = state.products.findIndex(x => x.id === p.id);
      state.products[idx] = obj;
    } else {
      state.products.push(obj);
    }
    await db.put('products', obj);
    el.remove();
    const clean = Object.assign({}, obj);
    delete clean.imageBlob;
    await persistOp('product_upsert', { product: clean });
    toast(p ? '商品已更新' : '商品已添加');
    refresh();
  });
}

async function deleteProduct(id) {
  const p = productById(id);
  if (!p) return;
  const hasMovements = state.movements.some(m => m.productId === id);
  const ok = await confirmDialog({
    title: '删除商品',
    message: hasMovements
      ? `「${esc(p.name)}」存在出入库记录。<br>删除商品会<b>同时删除其全部流水</b>，库存数据将随之变化，此操作不可恢复。`
      : `确定删除商品「${esc(p.name)}」吗？此操作不可恢复。`,
    danger: true, confirmText: '删除',
  });
  if (!ok) return;
  revokeImage(p);
  state.products = state.products.filter(x => x.id !== id);
  const removed = state.movements.filter(m => m.productId === id);
  state.movements = state.movements.filter(m => m.productId !== id);
  await db.del('products', id);
  for (const m of removed) await db.del('movements', m.id);
  recomputeStock();
  await persistOp('product_delete', { id });
  toast('商品已删除');
  refresh();
}

/* ---------------- 进货 ---------------- */
async function addMovement({ productId, type, quantity, unitPrice, cost, date, party, note, saleNo }) {
  const q = round2(quantity);
  const m = {
    id: uid(), type, productId, quantity: q,
    unitPrice: round2(unitPrice || 0),
    cost: round2(cost != null ? cost : (type === 'out' ? (productById(productId).purchasePrice || 0) : unitPrice || 0)),
    total: type === 'adjust' ? 0 : round2(q * (unitPrice || 0)),
    date: date || todayStr(),
    party: party || '',
    note: note || '',
    saleNo: saleNo || '',
    createdAt: new Date().toISOString(),
  };
  state.movements.push(m);
  await db.put('movements', m);
  if (type === 'in' && unitPrice > 0) {
    const p = productById(productId);
    if (p && p.purchasePrice !== round2(unitPrice)) {
      p.purchasePrice = round2(unitPrice);
      await db.put('products', p);
    }
  }
  recomputeStock();
  return m;
}

async function submitPurchase(fields, keepOpen, modalEl) {
  const p = productById(fields.productId);
  if (!p) { toast('请先选择商品（或先到「商品管理」添加）', 'error'); return; }
  const qty = round2(parseFloat(fields.qty));
  if (!(qty > 0)) { toast('进货数量必须大于 0', 'error'); return; }
  const price = round2(parseFloat(fields.price) || 0);
  const m = await addMovement({ productId: p.id, type: 'in', quantity: qty, unitPrice: price, date: fields.date, party: fields.party, note: fields.note });
  await persistOp('purchase', { movement: m });
  toast(`已入库 +${fmtQty(qty)} ${esc(p.unit || '件')}「${esc(p.name)}」`);
  if (modalEl) modalEl.remove();
  refresh();
}

function bindPurchaseSelect(selectEl, priceEl, infoEl) {
  if (!selectEl) return;
  selectEl.addEventListener('change', () => {
    const p = productById(selectEl.value);
    if (p && priceEl && priceEl.value === '') priceEl.value = p.purchasePrice || '';
    if (infoEl) renderPurchaseInfo(infoEl, selectEl.value);
  });
}

/* 进货/调整时展示所选商品的详细信息（含图片），避免同名商品选错 */
function renderPurchaseInfo(container, productId) {
  const p = productById(productId);
  if (!p) { container.innerHTML = ''; return; }
  const low = isLowStock(p);
  container.innerHTML = `
    <div class="product-info-card">
      <div class="pi-img">${imgHtml(p)}</div>
      <div class="pi-body">
        <div class="pi-name">${esc(p.name)} ${badgeHtml(p.category || '其他', p.category)}</div>
        <div class="pi-id">产品ID：${esc(p.id || '-')}</div>
        <div class="pi-meta">规格 ${esc(p.spec || '-')} · 单位 ${esc(p.unit || '-')}</div>
        <div class="pi-meta">当前库存 <b class="${low ? 'low' : ''}">${fmtQty(stockOf(p.id))}</b> ${esc(p.unit || '')} · 进价 ${money(p.purchasePrice || 0)} · 售价 ${money(p.salePrice || 0)}</div>
        ${p.note ? `<div class="pi-note">备注：${esc(p.note)}</div>` : ''}
      </div>
    </div>`;
}

function renderPurchase() {
  $('#purchaseProduct').innerHTML = productOptions();
  $('#purchaseDate').value = todayStr();
  renderPurchaseInfo($('#purchaseInfo'), $('#purchaseProduct').value);
  const rows = state.movements.filter(m => m.type === 'in');
  $('#purchaseSummary').textContent = rows.length ? `共 ${rows.length} 笔，合计 ${money(sum(rows, r => r.total))}` : '';
  const tb = $('#purchaseTable');
  if (!rows.length) {
    tb.innerHTML = '<tbody><tr class="tbl-empty"><td>还没有进货记录</td></tr></tbody>';
    return;
  }
  const sorted = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  tb.innerHTML = `
    <thead><tr><th>日期</th><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th>供应商</th><th>备注</th><th class="center">操作</th></tr></thead>
    <tbody>${sorted.map(m => {
      const p = productById(m.productId);
      return `<tr>
        <td>${esc(m.date)}</td>
        <td class="t-strong">${p ? esc(p.name) + ' <span class="p-id">' + esc(p.id || '') + '</span>' : '<span class="muted">（商品已删除）</span>'}</td>
        <td class="num qty-pos">+${fmtQty(m.quantity)}${p ? esc(p.unit || '') : ''}</td>
        <td class="num">${money(m.unitPrice)}</td>
        <td class="num">${money(m.total)}</td>
        <td>${esc(m.party) || '<span class="muted">—</span>'}</td>
        <td>${esc(m.note) || '<span class="muted">—</span>'}</td>
        <td class="center"><button class="row-btn danger" data-del="${m.id}">删除</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

function openPurchaseModal(prefillId) {
  const el = openModal(`
    <div class="modal-head"><h2>记一笔进货</h2><button class="modal-x" data-close>✕</button></div>
    <div class="modal-body">
      <form id="purchaseModalForm" class="form-grid" autocomplete="off">
        <label><span>商品<span class="req">*</span></span><select id="pmProduct" class="select">${productOptions(prefillId)}</select></label>
        <label><span>数量<span class="req">*</span></span><input id="pmQty" class="input" type="number" step="0.01" min="0" placeholder="0"></label>
        <label>进货单价（¥）<input id="pmPrice" class="input" type="number" step="0.01" min="0" placeholder="0.00"></label>
        <label>日期<input id="pmDate" class="input" type="date"></label>
        <label>供应商<input id="pmSupplier" class="input" placeholder="如：武夷山茶厂"></label>
        <label>备注<input id="pmNote" class="input" placeholder="可选"></label>
      </form>
      <div class="product-info" id="pmInfo"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" form="purchaseModalForm" type="submit">保存进货</button>
    </div>`);
  $('#pmDate', el).value = todayStr();
  bindPurchaseSelect($('#pmProduct', el), $('#pmPrice', el), $('#pmInfo', el));
  if (prefillId) {
    const p = productById(prefillId);
    if (p) $('#pmPrice', el).value = p.purchasePrice || '';
  }
  renderPurchaseInfo($('#pmInfo', el), $('#pmProduct', el).value);
  $('#purchaseModalForm', el).addEventListener('submit', async e => {
    e.preventDefault();
    await submitPurchase({
      productId: $('#pmProduct', el).value,
      qty: $('#pmQty', el).value,
      price: $('#pmPrice', el).value,
      date: $('#pmDate', el).value,
      party: $('#pmSupplier', el).value.trim(),
      note: $('#pmNote', el).value.trim(),
    }, false, el);
  });
}

/* ---------------- 销售开单（POS） ---------------- */
function openSaleModal() {
  if (!state.products.filter(p => !p.hidden).length) {
    toast(state.products.length ? '没有在售商品（所有商品均已隐藏）' : '请先到「商品管理」添加商品', 'error');
    return;
  }
  const cart = [];
  const el = openModal(`
    <div class="modal-head"><h2>新建销售单</h2><button class="modal-x" data-close>✕</button></div>
    <div class="modal-body">
      <div class="pos-wrap">
        <div class="pos-left">
          <div class="search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="posSearch" placeholder="搜索商品…" autocomplete="off">
          </div>
          <div class="pos-list" id="posList"></div>
        </div>
        <div class="pos-right">
          <div class="pos-cart" id="posCart"></div>
          <div class="pos-meta">
            <label>日期<input type="date" id="posDate" class="input"></label>
            <label>客户<input id="posCustomer" class="input" placeholder="散客"></label>
            <label class="span2">备注<input id="posNote" class="input" placeholder="可选"></label>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot pos-foot">
      <div class="pos-total-wrap">合计 <b id="posTotal">¥0.00</b></div>
      <button class="btn btn-primary btn-lg" id="posCheckout">确认收款并开单</button>
    </div>`, { wide: true, cls: 'modal-pos' });

  const listEl = $('#posList', el), cartEl = $('#posCart', el), totalEl = $('#posTotal', el);
  $('#posDate', el).value = todayStr();

  function renderList() {
    const kw = $('#posSearch', el).value.trim().toLowerCase();
    const items = state.products.filter(p =>
      !p.hidden && (!kw || (p.name || '').toLowerCase().includes(kw) || (p.spec || '').toLowerCase().includes(kw) || (p.category || '').toLowerCase().includes(kw) || (p.id || '').toLowerCase().includes(kw))
    );
    if (!items.length) { listEl.innerHTML = `<div class="empty">未找到商品</div>`; return; }
    listEl.innerHTML = items.map(p => `
      <div class="pos-item" data-id="${p.id}">
        <div class="pos-thumb">${imgHtml(p)}</div>
        <div class="pos-info">
          <div class="pos-name">${esc(p.name)}</div>
          <div class="pos-sub">${esc(p.category || '')}${p.spec ? ' · ' + esc(p.spec) : ''} · ${esc(p.id || '')} · 库存 ${fmtQty(stockOf(p.id))}${esc(p.unit || '')}</div>
        </div>
        <div class="pos-price">${money(p.salePrice || 0)}</div>
      </div>`).join('');
  }

  function renderCart() {
    if (!cart.length) {
      cartEl.innerHTML = `<div class="empty"><span class="empty-icon">🛒</span>点击左侧商品加入购物车<br><small>可修改数量与售价</small></div>`;
      totalEl.textContent = money(0);
      return;
    }
    cartEl.innerHTML = cart.map((c, i) => {
      const p = productById(c.productId);
      return `
      <div class="cart-row" data-i="${i}">
        <div class="cart-name">${esc(p.name)}<span class="cart-sub">库存 ${fmtQty(stockOf(p.id))}${esc(p.unit || '')}</span></div>
        <div class="cart-ctrl">
          <button class="qty-btn" type="button" data-i="${i}" data-d="-1">−</button>
          <input class="qty-input" data-i="${i}" type="number" step="0.01" min="0" value="${fmtQty(c.qty)}">
          <button class="qty-btn" type="button" data-i="${i}" data-d="1">+</button>
        </div>
        <input class="price-input" data-i="${i}" type="number" step="0.01" min="0" value="${round2(c.price)}">
        <div class="cart-line">${money(round2(c.qty * c.price))}</div>
        <button class="cart-del" type="button" data-i="${i}" title="移除">✕</button>
      </div>`;
    }).join('');
    totalEl.textContent = money(sum(cart, c => c.qty * c.price));
  }

  listEl.addEventListener('click', e => {
    const item = e.target.closest('.pos-item');
    if (!item) return;
    const pid = item.dataset.id;
    const p = productById(pid);
    if (!p) return;
    const found = cart.find(c => c.productId === pid);
    if (found) found.qty = round2(found.qty + 1);
    else cart.push({ productId: pid, qty: 1, price: round2(p.salePrice || 0) });
    renderCart();
  });

  cartEl.addEventListener('click', e => {
    const del = e.target.closest('.cart-del');
    if (del) { cart.splice(Number(del.dataset.i), 1); renderCart(); return; }
    const qb = e.target.closest('.qty-btn');
    if (qb) {
      const c = cart[Number(qb.dataset.i)];
      if (!c) return;
      c.qty = Math.max(0, round2(c.qty + Number(qb.dataset.d)));
      renderCart();
    }
  });

  cartEl.addEventListener('input', e => {
    const t = e.target;
    const c = cart[Number(t.dataset.i)];
    if (!c) return;
    if (t.classList.contains('qty-input')) c.qty = Math.max(0, round2(parseFloat(t.value) || 0));
    if (t.classList.contains('price-input')) c.price = Math.max(0, round2(parseFloat(t.value) || 0));
    totalEl.textContent = money(sum(cart, x => x.qty * x.price));
  });

  $('#posSearch', el).addEventListener('input', renderList);
  renderList(); renderCart();

  $('#posCheckout', el).addEventListener('click', () => checkoutSale(cart, el));
}

async function checkoutSale(cart, modalEl) {
  const items = cart.filter(c => c.qty > 0);
  if (!items.length) { toast('请先添加商品', 'error'); return; }
  if (!state.settings.allowNegative) {
    const shortages = items.filter(c => c.qty > stockOf(c.productId));
    if (shortages.length) {
      toast('库存不足：' + shortages.map(c => productById(c.productId).name).join('、'), 'error', 4000);
      return;
    }
  }
  const date = $('#posDate', modalEl).value || todayStr();
  const customer = $('#posCustomer', modalEl).value.trim();
  const note = $('#posNote', modalEl).value.trim();
  const saleNo = 'XS' + date.replace(/-/g, '') + Math.floor(Math.random() * 900 + 100);

  const created = [];
  for (const c of items) {
    const p = productById(c.productId);
    created.push(await addMovement({ productId: c.productId, type: 'out', quantity: c.qty, unitPrice: c.price, date, party: customer, note, saleNo }));
  }
  const total = round2(sum(items, c => c.qty * c.price));
  // 整单作为一个事务提交：要么全部减库存+记流水成功，要么全部回滚
  await persistOp('sale', { saleNo, date, party: customer, note, items: created });
  modalEl.remove();
  toast(`销售单已保存，合计 ${money(total)}`);

  const res = openModal(`
    <div class="modal-head"><h2>✅ 开单成功</h2></div>
    <div class="modal-body">
      <p class="confirm-msg">销售单 <b>${esc(saleNo)}</b> 已保存，共 ${items.length} 种商品，合计 <span class="big">${money(total)}</span><br>库存已自动扣减。</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>完成</button>
      <button class="btn btn-ghost" id="btnAgain">继续开单</button>
      <button class="btn btn-primary" id="btnPrintSale">打印小票</button>
    </div>`, { sm: true });
  $('#btnAgain', res).addEventListener('click', () => { res.remove(); openSaleModal(); });
  $('#btnPrintSale', res).addEventListener('click', () => { res.remove(); printSale(saleNo); });
  refresh();
}

function renderSales() {
  const outs = state.movements.filter(m => m.type === 'out');
  $('#saleSummary').textContent = outs.length ? `共 ${outs.length} 笔流水，合计 ${money(sum(outs, o => o.total))}` : '';
  // 按单号分组
  const groups = new Map();
  outs.forEach(m => {
    const key = m.saleNo || m.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  const rows = [...groups.entries()].sort((a, b) => {
    const da = a[1][0], db = b[1][0];
    return (db.date || '').localeCompare(da.date || '') || (db.createdAt || '').localeCompare(da.createdAt || '');
  });
  const tb = $('#saleTable');
  if (!rows.length) { tb.innerHTML = '<tbody><tr class="tbl-empty"><td>还没有销售记录</td></tr></tbody>'; return; }
  tb.innerHTML = `
    <thead><tr><th>单号</th><th>时间</th><th class="num">商品种类</th><th class="num">合计金额</th><th>客户</th><th>备注</th><th class="center">操作</th></tr></thead>
    <tbody>${rows.map(([no, ms]) => {
      const first = ms[0];
      const total = round2(sum(ms, m => m.total));
      const names = ms.map(m => productById(m.productId) ? productById(m.productId).name : '（已删除）').join('、');
      return `<tr>
        <td class="t-strong">${esc(no)}</td>
        <td>${esc(first.date)} ${dateTimeStr(first.createdAt).slice(11)}</td>
        <td class="num">${ms.length} 种</td>
        <td class="num">${money(total)}</td>
        <td>${esc(first.party) || '<span class="muted">散客</span>'}</td>
        <td title="${esc(names)}">${esc(first.note) || '<span class="muted">—</span>'}</td>
        <td class="center">
          <button class="row-btn" data-detail="${esc(no)}">详情</button>
          <button class="row-btn" data-print="${esc(no)}">打印</button>
          <button class="row-btn danger" data-delsale="${esc(no)}">删除</button>
        </td>
      </tr>`;
    }).join('')}</tbody>`;
}

/* 销售单详情：展示每种商品的图片、名称、规格、数量、单价等 */
function openSaleDetail(saleNo) {
  const ms = state.movements.filter(m => m.type === 'out' && m.saleNo === saleNo);
  if (!ms.length) return;
  const first = ms[0];
  const total = round2(sum(ms, m => m.total));
  const el = openModal(`
    <div class="modal-head"><h2>销售单详情 <span class="p-id">${esc(saleNo)}</span></h2><button class="modal-x" data-close>✕</button></div>
    <div class="modal-body">
      <div class="detail-meta">
        <span>日期：<b>${esc(first.date)} ${dateTimeStr(first.createdAt).slice(11)}</b></span>
        <span>客户：<b>${esc(first.party) || '散客'}</b></span>
        ${first.note ? `<span>备注：${esc(first.note)}</span>` : ''}
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>商品</th><th>分类</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead>
          <tbody>${ms.map(m => {
            const p = productById(m.productId);
            return `<tr>
              <td>
                <div class="detail-product">
                  <div class="dt-thumb">${p ? imgHtml(p) : '❓'}</div>
                  <div>
                    <div class="t-strong">${p ? esc(p.name) : '<span class="muted">（商品已删除）</span>'}</div>
                    <div class="muted" style="font-size:12px">${p ? esc(p.id || '') + (p.spec ? ' · ' + esc(p.spec) : '') + ' · ' + esc(p.unit || '') : ''}</div>
                  </div>
                </div>
              </td>
              <td>${p ? esc(p.category || '') : ''}</td>
              <td class="num qty-neg">-${fmtQty(m.quantity)}</td>
              <td class="num">${money(m.unitPrice)}</td>
              <td class="num">${money(m.total)}</td>
            </tr>`;
          }).join('')}
          <tr style="background:#F7F4EA;font-weight:700">
            <td colspan="2">合计（${ms.length} 种商品）</td>
            <td class="num">${fmtQty(sum(ms, m => m.quantity))}</td>
            <td></td>
            <td class="num">${money(total)}</td>
          </tr></tbody>
        </table>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="dlPrint">打印小票</button>
    </div>`, { wide: true, cls: 'modal-detail' });
  $('#dlPrint', el).addEventListener('click', () => { el.remove(); printSale(saleNo); });
}

async function deleteSale(saleNo) {
  const ms = state.movements.filter(m => m.type === 'out' && m.saleNo === saleNo);
  if (!ms.length) return;
  const total = round2(sum(ms, m => m.total));
  const ok = await confirmDialog({
    title: '删除销售单',
    message: `删除销售单 <b>${esc(saleNo)}</b>（${ms.length} 种商品，合计 ${money(total)}）？<br>相关商品库存将<b>自动加回</b>。`,
    danger: true, confirmText: '删除',
  });
  if (!ok) return;
  for (const m of ms) await db.del('movements', m.id);
  state.movements = state.movements.filter(m => !(m.type === 'out' && m.saleNo === saleNo));
  recomputeStock();
  await persistOp('sale_delete', { saleNo });
  toast('销售单已删除，库存已回退');
  refresh();
}

/* ---------------- 库存调整 ---------------- */
function openAdjustModal(prefillId) {
  const el = openModal(`
    <div class="modal-head"><h2>库存调整</h2><button class="modal-x" data-close>✕</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-bottom:12px">用于盘点修正、破损报废、赠品等场景。保存后库存将直接变为填写的新数量，并记录一条调整流水。</p>
      <form id="adjustForm" class="form-grid" autocomplete="off">
        <label><span>商品<span class="req">*</span></span><select id="adProduct" class="select">${productOptions(prefillId, true)}</select></label>
        <label>当前库存<input id="adCurrent" class="input" disabled></label>
        <label><span>调整为<span class="req">*</span></span><input id="adNew" class="input" type="number" step="0.01" min="0" placeholder="新库存数量"></label>
        <label class="span2">调整原因<input id="adNote" class="input" placeholder="如：盘点 / 破损 / 赠品"></label>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" form="adjustForm" type="submit">保存调整</button>
    </div>`);
  const curEl = $('#adCurrent', el);
  const sync = () => {
    const p = productById($('#adProduct', el).value);
    curEl.value = p ? fmtQty(stockOf(p.id)) + (p.unit ? ' ' + p.unit : '') : '';
    $('#adNew', el).value = p ? fmtQty(stockOf(p.id)) : '';
  };
  $('#adProduct', el).addEventListener('change', sync);
  sync();
  $('#adjustForm', el).addEventListener('submit', async e => {
    e.preventDefault();
    const p = productById($('#adProduct', el).value);
    if (!p) { toast('请先选择商品', 'error'); return; }
    const newQty = round2(parseFloat($('#adNew', el).value));
    if (isNaN(newQty) || newQty < 0) { toast('请输入有效的新库存数量', 'error'); return; }
    const delta = round2(newQty - stockOf(p.id));
    if (delta === 0) { toast('库存数量没有变化'); el.remove(); return; }
    const m = await addMovement({ productId: p.id, type: 'adjust', quantity: delta, unitPrice: 0, date: todayStr(), party: '', note: $('#adNote', el).value.trim() || '库存调整' });
    await persistOp('adjust', { movement: m });
    el.remove();
    toast(`「${esc(p.name)}」库存调整为 ${fmtQty(newQty)} ${esc(p.unit || '')}`);
    refresh();
  });
}

function renderMovements() {
  // 库存表
  const st = [...state.products].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  const stb = $('#stockTable');
  if (!st.length) {
    stb.innerHTML = '<tbody><tr class="tbl-empty"><td>暂无商品，请先添加</td></tr></tbody>';
  } else {
    stb.innerHTML = `
      <thead><tr><th>商品</th><th>分类</th><th>规格</th><th class="num">库存</th><th class="num">进价</th><th class="num">售价</th><th class="num">库存金额</th><th class="center">操作</th></tr></thead>
      <tbody>${st.map(p => {
        const s = stockOf(p.id);
        const low = isLowStock(p);
        return `<tr>
          <td class="t-strong"><a class="prod-link" data-edit="${p.id}">${esc(p.name)}</a> <span class="p-id">${esc(p.id || '')}</span>${low ? ' <span class="badge" style="background:#FBEAE5;color:#C04A32">低</span>' : ''}${p.hidden ? ' <span class="badge" style="background:#EFEDE7;color:#6B6455">已隐藏</span>' : ''}</td>
          <td>${esc(p.category || '其他')}</td>
          <td>${esc(p.spec) || '<span class="muted">—</span>'}</td>
          <td class="num ${low ? 'qty-neg' : ''}">${fmtQty(s)} ${esc(p.unit || '')}</td>
          <td class="num">${money(p.purchasePrice || 0)}</td>
          <td class="num">${money(p.salePrice || 0)}</td>
          <td class="num">${money(s * (p.purchasePrice || 0))}</td>
          <td class="center"><button class="row-btn" data-adjust="${p.id}">调整</button></td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  // 流水表
  const fType = $('#mfType').value, fFrom = $('#mfFrom').value, fTo = $('#mfTo').value, kw = $('#mfSearch').value.trim().toLowerCase();
  const rows = sortedMovements().filter(m => {
    if (fType && m.type !== fType) return false;
    if (!inRange(m, fFrom, fTo)) return false;
    if (kw) {
      const p = productById(m.productId);
      const hay = `${p ? p.name + p.spec : ''} ${m.party} ${m.note}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const mtb = $('#movementTable');
  if (!rows.length) {
    mtb.innerHTML = '<tbody><tr class="tbl-empty"><td>没有符合条件的流水</td></tr></tbody>';
    return;
  }
  mtb.innerHTML = `
    <thead><tr><th>日期</th><th>时间</th><th>类型</th><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th>对方</th><th>备注</th><th class="center">操作</th></tr></thead>
    <tbody>${rows.map(m => {
      const p = productById(m.productId);
      const qtyHtml = m.type === 'out'
        ? `<span class="qty-neg">-${fmtQty(m.quantity)}</span>`
        : m.type === 'in'
          ? `<span class="qty-pos">+${fmtQty(m.quantity)}</span>`
          : `<span class="qty-adjust">${m.quantity >= 0 ? '+' : ''}${fmtQty(m.quantity)}</span>`;
      return `<tr>
        <td>${esc(m.date)}</td>
        <td class="muted">${dateTimeStr(m.createdAt).slice(11)}</td>
        <td><span class="badge ${TYPE_META[m.type].cls}">${TYPE_META[m.type].label}</span></td>
        <td class="t-strong">${p ? esc(p.name) : '<span class="muted">（商品已删除）</span>'}</td>
        <td class="num">${qtyHtml}${p ? esc(p.unit || '') : ''}</td>
        <td class="num">${m.type === 'adjust' ? '<span class="muted">—</span>' : money(m.unitPrice)}</td>
        <td class="num">${m.type === 'adjust' ? '<span class="muted">—</span>' : money(m.total)}</td>
        <td>${esc(m.party) || '<span class="muted">—</span>'}</td>
        <td>${esc(m.note) || '<span class="muted">—</span>'}</td>
        <td class="center"><button class="row-btn danger" data-del="${m.id}">删除</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

async function deleteMovement(id) {
  const m = state.movements.find(x => x.id === id);
  if (!m) return;
  const p = productById(m.productId);
  const ok = await confirmDialog({
    title: '删除流水',
    message: `删除这笔<b>${TYPE_META[m.type].label}</b>记录（${esc(p ? p.name : '已删除商品')} ${m.type === 'out' ? '-' : m.type === 'in' ? '+' : ''}${fmtQty(m.quantity)}${p ? esc(p.unit || '') : ''}）？<br>库存将自动重新计算。`,
    danger: true, confirmText: '删除',
  });
  if (!ok) return;
  await db.del('movements', id);
  state.movements = state.movements.filter(x => x.id !== id);
  recomputeStock();
  await persistOp('movement_delete', { id, type: m.type });
  toast('流水已删除');
  refresh();
}

/* ---------------- 首页 ---------------- */
function renderDashboard() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const monthMovs = state.movements.filter(m => (m.date || '').startsWith(ym));
  const sales = monthMovs.filter(m => m.type === 'out');
  const revenue = round2(sum(sales, s => s.total));
  const cost = round2(sum(sales, s => s.quantity * (s.cost || 0)));
  const lowList = state.products.filter(p => !p.hidden && isLowStock(p));
  const online = state.products.filter(p => !p.hidden);

  $('#statGrid').innerHTML = [
    ['🍵', 'green', online.length, '在线商品', '种'],
    ['📦', 'blue', online.filter(p => stockOf(p.id) > 0).length, '有货商品', '种'],
    ['💰', 'amber', money(stockValue()), '库存总值', ''],
    ['🧾', 'blue', money(revenue), '本月销售额', ''],
    ['📈', 'green', money(revenue - cost), '本月毛利', ''],
    ['⚠️', 'red', lowList.length, '低库存提醒', '种'],
  ].map(([icon, tone, value, label, unit]) => `
    <div class="stat-card">
      <div class="stat-icon ${tone}">${icon}</div>
      <div><div class="stat-value">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="stat-label">${label}</div></div>
    </div>`).join('');

  // 低库存列表
  const ll = $('#lowStockList');
  if (!lowList.length) {
    ll.innerHTML = `<div class="mini-empty">🎉 暂无低库存商品</div>`;
  } else {
    ll.innerHTML = `<div class="mini-list">${lowList.slice(0, 8).map(p => `
      <div class="mini-item">
        <div class="mini-main">
          <div class="mini-name">${esc(p.name)}</div>
          <div class="mini-sub">${esc(p.category || '')}${p.spec ? ' · ' + esc(p.spec) : ''}</div>
        </div>
        <div class="mini-right red">剩 ${fmtQty(stockOf(p.id))} ${esc(p.unit || '')}</div>
        <button class="btn btn-ghost btn-sm" data-restock="${p.id}">补货</button>
      </div>`).join('')}</div>`;
  }

  // 最近流水
  const rm = $('#recentMovements');
  const recent = sortedMovements().slice(0, 8);
  if (!recent.length) {
    rm.innerHTML = `<div class="mini-empty">还没有流水记录，试试记一笔进货或开一单销售</div>`;
  } else {
    rm.innerHTML = `<div class="mini-list">${recent.map(m => {
      const p = productById(m.productId);
      const sign = m.type === 'out' ? '-' : m.type === 'in' ? '+' : (m.quantity >= 0 ? '+' : '');
      const cls = m.type === 'out' ? 'red' : m.type === 'in' ? 'green' : '';
      return `
      <div class="mini-item">
        <span class="badge ${TYPE_META[m.type].cls}">${TYPE_META[m.type].label}</span>
        <div class="mini-main">
          <div class="mini-name">${p ? esc(p.name) : '（已删除商品）'}</div>
          <div class="mini-sub">${esc(m.date)}${m.party ? ' · ' + esc(m.party) : ''}</div>
        </div>
        <div class="mini-right ${cls}">${sign}${fmtQty(m.quantity)}${p ? esc(p.unit || '') : ''}${m.type !== 'adjust' ? ' · ' + money(m.total) : ''}</div>
      </div>`;
    }).join('')}</div>`;
  }
}

/* ---------------- 统计报表 ---------------- */
function periodRange(p) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const fmt = (yy, mm, dd) => `${yy}-${pad2(mm + 1)}-${pad2(dd)}`;
  switch (p) {
    case 'today':
      return { from: fmt(y, m, now.getDate()), to: fmt(y, m, now.getDate()) };
    case 'week': {
      const day = now.getDay() || 7;
      const mon = new Date(y, m, now.getDate() - day + 1);
      const sun = new Date(y, m, now.getDate() - day + 7);
      return { from: fmt(mon.getFullYear(), mon.getMonth(), mon.getDate()), to: fmt(sun.getFullYear(), sun.getMonth(), sun.getDate()) };
    }
    case 'month':
      return { from: fmt(y, m, 1), to: fmt(y, m, new Date(y, m + 1, 0).getDate()) };
    case 'lastMonth': {
      const ly = m === 0 ? y - 1 : y, lm = m === 0 ? 11 : m - 1;
      return { from: fmt(ly, lm, 1), to: fmt(ly, lm, new Date(ly, lm + 1, 0).getDate()) };
    }
    case 'custom':
      return { from: $('#rpFrom').value || '', to: $('#rpTo').value || '' };
  }
}

function calcReport(from, to) {
  const sales = state.movements.filter(m => m.type === 'out' && inRange(m, from, to));
  const buys = state.movements.filter(m => m.type === 'in' && inRange(m, from, to));
  const revenue = round2(sum(sales, s => s.total));
  const cost = round2(sum(sales, s => s.quantity * (s.cost || 0)));
  const perProduct = new Map();
  sales.forEach(s => {
    if (!perProduct.has(s.productId)) perProduct.set(s.productId, { qty: 0, revenue: 0, cost: 0 });
    const r = perProduct.get(s.productId);
    r.qty = round2(r.qty + s.quantity);
    r.revenue = round2(r.revenue + s.total);
    r.cost = round2(r.cost + s.quantity * (s.cost || 0));
  });
  return {
    from, to,
    count: sales.length,
    revenue, cost,
    gross: round2(revenue - cost),
    purchase: round2(sum(buys, b => b.total)),
    perProduct: [...perProduct.entries()].map(([pid, r]) => ({ product: productById(pid), ...r }))
      .filter(x => x.product)
      .sort((a, b) => b.revenue - a.revenue),
  };
}

function renderReport() {
  const p = state.reportPeriod;
  $$('#periodSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.p === p));
  const custom = p === 'custom';
  $('#rpFrom').disabled = !custom;
  $('#rpTo').disabled = !custom;
  if (!custom) {
    const r = periodRange(p);
    $('#rpFrom').value = r.from;
    $('#rpTo').value = r.to;
  }
  const { from, to } = periodRange(p);
  if (!from || !to) {
    $('#reportStats').innerHTML = '<div class="empty">请选择完整的日期范围</div>';
    $('#reportSub').textContent = '';
    $('#reportTable').innerHTML = '<tbody><tr class="tbl-empty"><td>—</td></tr></tbody>';
    return;
  }
  const rep = calcReport(from, to);
  $('#reportStats').innerHTML = [
    ['🧾', 'blue', money(rep.revenue), '销售额', ''],
    ['📈', 'green', money(rep.gross), '毛利', ''],
    ['💹', 'green', rep.revenue ? Math.round(rep.gross / rep.revenue * 100) + '%' : '—', '毛利率', ''],
    ['📥', 'amber', money(rep.purchase), '进货额', ''],
    ['🧮', 'gray', rep.count, '销售笔数', '笔'],
  ].map(([icon, tone, value, label, unit]) => `
    <div class="stat-card">
      <div class="stat-icon ${tone}">${icon}</div>
      <div><div class="stat-value">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="stat-label">${label}</div></div>
    </div>`).join('');

  $('#reportSub').textContent = `${from} 至 ${to}`;
  const tb = $('#reportTable');
  if (!rep.perProduct.length) {
    tb.innerHTML = '<tbody><tr class="tbl-empty"><td>该时间段内没有销售记录</td></tr></tbody>';
    return;
  }
  tb.innerHTML = `
    <thead><tr><th>商品</th><th>分类</th><th class="num">销量</th><th class="num">销售额</th><th class="num">成本</th><th class="num">毛利</th><th class="num">当前库存</th></tr></thead>
    <tbody>${rep.perProduct.map(x => {
      const p = x.product;
      const profit = round2(x.revenue - x.cost);
      return `<tr>
        <td class="t-strong">${esc(p.name)}${p.spec ? ` <span class="muted">(${esc(p.spec)})</span>` : ''}</td>
        <td>${esc(p.category || '')}</td>
        <td class="num">${fmtQty(x.qty)} ${esc(p.unit || '')}</td>
        <td class="num">${money(x.revenue)}</td>
        <td class="num">${money(x.cost)}</td>
        <td class="num ${profit >= 0 ? 'qty-pos' : 'qty-neg'}">${money(profit)}</td>
        <td class="num">${fmtQty(stockOf(p.id))} ${esc(p.unit || '')}</td>
      </tr>`;
    }).join('')}
    <tr style="background:#F7F4EA;font-weight:700">
      <td>合计</td><td></td>
      <td class="num">${fmtQty(sum(rep.perProduct, x => x.qty))}</td>
      <td class="num">${money(rep.revenue)}</td>
      <td class="num">${money(rep.cost)}</td>
      <td class="num">${money(rep.gross)}</td>
      <td></td>
    </tr></tbody>`;
}

function exportReportCsv() {
  const from = $('#rpFrom').value, to = $('#rpTo').value;
  const rep = calcReport(from, to);
  let csv = `商品,分类,销量,销售额,成本,毛利,当前库存\n`;
  rep.perProduct.forEach(x => {
    const p = x.product;
    csv += `${p.name}${p.spec ? '(' + p.spec + ')' : ''},${p.category || ''},${x.qty},${x.revenue},${x.cost},${round2(x.revenue - x.cost)},${stockOf(p.id)}\n`;
  });
  csv += `合计,,${fmtQty(sum(rep.perProduct, x => x.qty))},${rep.revenue},${rep.cost},${rep.gross},\n`;
  download(`销售统计_${from}_${to}.csv`, csv);
  toast('CSV 已导出');
}

/* ---------------- 设置 / 备份 ---------------- */
function logoUrl() {
  if (!state.logo) return '';
  if (!state.logoUrl) state.logoUrl = URL.createObjectURL(state.logo);
  return state.logoUrl;
}
function renderLogo() {
  const u = logoUrl();
  $('#brandLogo').innerHTML = u ? `<img src="${u}" alt="logo">` : '🍵';
}
function renderSettings() {
  $('#setShopName').value = state.settings.shopName || '';
  $('#setLowStock').value = state.settings.lowStock ?? '';
  $('#setAllowNegative').checked = !!state.settings.allowNegative;
  const u = logoUrl();
  $('#logoPreview').innerHTML = u ? `<img src="${u}" alt="logo">` : '🍵';
  renderStorageStatus();
}

/* 存储方式提示：磁盘模式显示正常状态；浏览器模式给出醒目警告 */
function renderStorageStatus() {
  const el = $('#storageStatus');
  const banner = $('#storageBanner');
  if (storage.mode === 'disk') {
    const backendText = storage.backend === 'sqlite' ? 'SQLite 数据库（WAL 模式）' : 'JSON 文件';
    if (el) el.innerHTML = `✅ <b>本地存储</b>：数据保存在本机 <code>${backendText}</code>（软件目录下），每次操作以事务/原子方式写入，更换浏览器、重启电脑数据都不会丢失。`;
    if (banner) banner.classList.add('hidden');
  } else {
    if (el) el.innerHTML = '⚠️ <b>当前为浏览器临时存储</b>：数据存在浏览器中，清理浏览器数据或更换浏览器会丢失！请双击 <code>start.bat</code> 启动本软件以获得本地存储。';
    if (banner) banner.classList.remove('hidden');
  }
}
async function saveLogo(blob) {
  if (state.logoUrl) { URL.revokeObjectURL(state.logoUrl); state.logoUrl = null; }
  state.logo = blob;
  state.logoDataUrl = null;
  const pth = await uploadImage(blob); // Logo 存为独立文件
  if (pth) state.logoPath = pth;
  await db.put('settings', { key: 'logo', value: blob });
  renderLogo(); renderSettings();
  await persistOp('settings', { settings: state.settings, logoPath: state.logoPath });
  toast('店铺 Logo 已更新');
}
async function removeLogo() {
  if (state.logoUrl) { URL.revokeObjectURL(state.logoUrl); state.logoUrl = null; }
  state.logo = null;
  state.logoDataUrl = null;
  state.logoPath = null;
  await db.del('settings', 'logo');
  renderLogo(); renderSettings();
  await persistOp('settings', { settings: state.settings, logoPath: null });
  toast('已恢复默认 Logo');
}

async function exportData() {
  // 导出自包含备份：图片以 Base64 内嵌，任何环境导入都能恢复
  const products = [];
  for (const p of state.products) {
    const c = Object.assign({}, p);
    delete c.imageBlob;
    if (c.imagePath) {
      const blob = await fetchImage(c.imagePath);
      if (blob) c.imageDataUrl = await blobToDataURL(blob);
      delete c.imagePath;
    }
    products.push(c);
  }
  let logoDataUrl = null;
  if (state.logoPath) {
    const blob = await fetchImage(state.logoPath);
    if (blob) logoDataUrl = await blobToDataURL(blob);
  } else if (state.logo) {
    logoDataUrl = await blobToDataURL(state.logo);
  }
  const json = {
    app: 'teaShopInventory', version: 3,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    logoDataUrl,
    products,
    movements: state.movements,
  };
  download(`茶店进销存备份_${todayStr()}.json`, JSON.stringify(json, null, 2));
  toast('备份文件已导出');
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { toast('文件解析失败，请选择正确的备份文件', 'error'); return; }
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.movements)) {
    toast('不是有效的备份文件', 'error'); return;
  }
  const ok = await confirmDialog({
    title: '导入备份',
    message: `将用备份文件（${data.products.length} 个商品、${data.movements.length} 条流水）<b>替换当前全部数据</b>，此操作不可撤销。建议先导出当前数据。`,
    danger: true, confirmText: '确认导入',
  });
  if (!ok) return;
  const products = [];
  for (const p of data.products) {
    const c = Object.assign({}, p);
    if (c.imageDataUrl) {
      c.imageBlob = await dataURLToBlob(c.imageDataUrl);
      delete c.imageDataUrl;
      delete c.imagePath; // 旧机器的路径不可用，保存时会重新上传
    } else if (c.imagePath) {
      c.imageBlob = await fetchImage(c.imagePath); // 同机备份：直接用原文件
    }
    products.push(c);
  }
  state.objUrls.forEach(u => URL.revokeObjectURL(u));
  state.objUrls.clear();
  if (state.logoUrl) { URL.revokeObjectURL(state.logoUrl); state.logoUrl = null; }
  state.imageDataUrls = new Map();
  state.logoDataUrl = null;
  state.logoPath = null;
  state.products = products;
  state.movements = data.movements || [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  if (data.logoDataUrl) {
    state.logo = await dataURLToBlob(data.logoDataUrl);
  } else if (data.logoPath) {
    state.logo = await fetchImage(data.logoPath);
  } else {
    state.logo = null;
  }
  recomputeStock();
  if (storage.mode === 'disk') {
    // 序列化商品（新图上传为独立文件）后整体导入，服务器端在一个事务内完成替换
    const ser = await serializeProducts(state.products);
    await persistOp('import', {
      products: ser,
      movements: state.movements,
      settings: state.settings,
      logoPath: state.logoPath || (state.logo ? await uploadImage(state.logo) : null),
    });
  } else {
    await db.replaceAll({ products, movements: state.movements, settings: state.settings });
    if (state.logo) await db.put('settings', { key: 'logo', value: state.logo });
    await loadSettings();
  }
  renderLogo();
  toast(`导入成功：${products.length} 个商品、${data.movements.length} 条流水`);
  refresh();
}

/* ---------------- 小票打印 ---------------- */
function printSale(saleNo) {
  const ms = state.movements.filter(m => m.type === 'out' && m.saleNo === saleNo);
  if (!ms.length) return;
  const first = ms[0];
  const rows = ms.map(m => {
    const p = productById(m.productId);
    return { name: p ? p.name : '（已删除）', spec: p ? p.spec : '', qty: m.quantity, price: m.unitPrice, amount: m.total };
  });
  const area = $('#printArea');
  area.innerHTML = `
    <div class="receipt">
      <div class="r-shop">${esc(state.settings.shopName || '茶语轩')}</div>
      <div class="r-title">销售小票</div>
      <div class="r-line"></div>
      <div class="r-meta"><span>单号：${esc(saleNo)}</span></div>
      <div class="r-meta"><span>日期：${esc(first.date)} ${dateTimeStr(first.createdAt).slice(11)}</span></div>
      ${first.party ? `<div class="r-meta"><span>客户：${esc(first.party)}</span></div>` : ''}
      <div class="r-line"></div>
      <table>
        <thead><tr><td>品名</td><td class="r">数量</td><td class="r">单价</td><td class="r">金额</td></tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td>${esc(r.name)}${r.spec ? `\n(${esc(r.spec)})` : ''}</td>
            <td class="r">${fmtQty(r.qty)}</td>
            <td class="r">${money(r.price)}</td>
            <td class="r">${money(r.amount)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="r-line"></div>
      <div class="r-total">合计：${money(sum(rows, r => r.amount))}</div>
      ${first.note ? `<div class="r-meta"><span>备注：${esc(first.note)}</span></div>` : ''}
      <div class="r-line"></div>
      <div class="r-foot">谢谢惠顾，欢迎再次光临！</div>
    </div>`;
  window.print();
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // 导航
  $$('.nav-item').forEach(n => n.addEventListener('click', () => showView(n.dataset.route)));

  // data-goto（如：查看全部低库存）
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]');
    if (!g) return;
    const [route, param] = g.dataset.goto.split('&');
    if (param) {
      const [k, v] = param.split('=');
      if (route === 'products' && k === 'low') {
        state.filters.low = v === '1';
        $('#lowStockOnly').checked = state.filters.low;
      }
    }
    showView(route);
  });

  // 商品列表：搜索 / 筛选 / 新增 / 卡片操作
  $('#productSearch').addEventListener('input', e => { state.filters.q = e.target.value; renderProducts(); });
  $('#categoryChips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.filters.cat = c.dataset.cat;
    renderProducts();
  });
  $('#lowStockOnly').addEventListener('change', e => { state.filters.low = e.target.checked; renderProducts(); });
  $('#showSeg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.filters.show = b.dataset.show;
    renderProducts();
  });
  $('#btnAddProduct').addEventListener('click', () => openProductModal(null));
  $('#productGrid').addEventListener('click', e => {
    const edit = e.target.closest('[data-edit]');
    if (edit) { e.stopPropagation(); openProductModal(edit.dataset.edit); return; }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteProduct(del.dataset.del); return; }
    const card = e.target.closest('.p-card');
    if (card) openProductModal(card.dataset.id);
  });

  // 进货页
  bindPurchaseSelect($('#purchaseProduct'), $('#purchasePrice'), $('#purchaseInfo'));
  $('#purchaseForm').addEventListener('submit', async e => {
    e.preventDefault();
    const keep = e.submitter && e.submitter.name === 'saveMore';
    const pid = $('#purchaseProduct').value;
    await submitPurchase({
      productId: pid,
      qty: $('#purchaseQty').value,
      price: $('#purchasePrice').value,
      date: $('#purchaseDate').value,
      party: $('#purchaseSupplier').value.trim(),
      note: $('#purchaseNote').value.trim(),
    }, keep, null);
    if (keep) {
      $('#purchaseProduct').value = pid; // 保存并继续：保留所选商品
    } else {
      $('#purchaseQty').value = ''; $('#purchasePrice').value = ''; $('#purchaseSupplier').value = ''; $('#purchaseNote').value = '';
    }
  });

  // 销售页
  $('#btnNewSale').addEventListener('click', openSaleModal);

  // 库存流水页
  $('#btnAdjust').addEventListener('click', () => openAdjustModal(null));
  ['mfType', 'mfFrom', 'mfTo'].forEach(id => $(`#${id}`).addEventListener('change', renderMovements));
  $('#mfSearch').addEventListener('input', renderMovements);
  $('#stockTable').addEventListener('click', e => {
    const a = e.target.closest('[data-adjust]');
    if (a) { openAdjustModal(a.dataset.adjust); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) openProductModal(ed.dataset.edit);
  });
  $('#movementTable').addEventListener('click', e => {
    const d = e.target.closest('[data-del]');
    if (d) deleteMovement(d.dataset.del);
  });

  // 销售记录表操作
  $('#saleTable').addEventListener('click', e => {
    const dt = e.target.closest('[data-detail]');
    if (dt) { openSaleDetail(dt.dataset.detail); return; }
    const p = e.target.closest('[data-print]');
    if (p) { printSale(p.dataset.print); return; }
    const d = e.target.closest('[data-delsale]');
    if (d) deleteSale(d.dataset.delsale);
  });

  // 进货记录表删除
  $('#purchaseTable').addEventListener('click', e => {
    const d = e.target.closest('[data-del]');
    if (d) deleteMovement(d.dataset.del);
  });

  // 首页补货快捷按钮
  $('#lowStockList').addEventListener('click', e => {
    const r = e.target.closest('[data-restock]');
    if (r) openPurchaseModal(r.dataset.restock);
  });

  // 报表
  $('#periodSeg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.reportPeriod = b.dataset.p;
    renderReport();
  });
  $('#rpFrom').addEventListener('change', () => { state.reportPeriod = 'custom'; renderReport(); });
  $('#rpTo').addEventListener('change', () => { state.reportPeriod = 'custom'; renderReport(); });
  $('#btnExportCsv').addEventListener('click', exportReportCsv);

  // 设置
  $('#settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    await saveSettings({
      shopName: $('#setShopName').value.trim() || '茶语轩',
      lowStock: Number($('#setLowStock').value) || 0,
      allowNegative: $('#setAllowNegative').checked,
    });
    toast('设置已保存');
    showView('settings');
  });
  $('#btnExportData').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });
  $('#logoInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('图片超过 8MB，请压缩后再上传', 'error'); return; }
    const blob = await processImage(f, 400);
    if (blob) saveLogo(blob);
    else toast('图片处理失败，请更换图片格式', 'error');
  });
  $('#logoRemove').addEventListener('click', () => confirmDialog({
    title: '恢复默认 Logo',
    message: '确定移除自定义 Logo，恢复为默认图标吗？',
    confirmText: '恢复默认',
  }).then(ok => { if (ok) removeLogo(); }));
  $('#btnClearData').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空所有数据',
      message: '将删除<b>全部商品、流水和设置</b>（服务器存储也会被清空），且无法恢复。确定继续吗？',
      danger: true, confirmText: '确认清空',
    });
    if (!ok) return;
    state.objUrls.forEach(u => URL.revokeObjectURL(u));
    state.objUrls.clear();
    state.imageDataUrls = new Map();
    if (state.logoUrl) { URL.revokeObjectURL(state.logoUrl); state.logoUrl = null; }
    state.logo = null;
    state.logoDataUrl = null;
    state.logoPath = null;
    state.products = [];
    state.movements = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    recomputeStock();
    if (storage.mode === 'disk') {
      await persistOp('clear', {});
    } else {
      await db.clear('products');
      await db.clear('movements');
      await db.clear('settings');
      await loadSettings();
    }
    renderLogo();
    renderStorageStatus();
    toast('所有数据已清空');
    refresh();
  });

  // 打印后清理
  window.addEventListener('afterprint', () => { $('#printArea').innerHTML = ''; });
}

/* ---------------- 启动 ---------------- */
async function init() {
  let migrated = false;
  try {
    // 先打开浏览器存储连接（磁盘模式下仅用于迁移旧数据；失败不阻塞启动）
    try { await db.open(); } catch (e) { /* 忽略：磁盘模式不依赖浏览器存储 */ }
    await storage.detect();
    if (storage.mode === 'disk') {
      const disk = await storage.load();
      if (disk && (disk.products.length || disk.movements.length)) {
        await hydrateFromDisk(disk);
      } else {
        // 磁盘还没有数据：若浏览器里存过旧数据，自动迁移到磁盘
        await loadFromIDB();
        if (state.products.length || state.movements.length) migrated = true;
      }
    } else {
      await loadFromIDB(); // 兜底：直接双击 index.html 时使用浏览器存储并给出警告
    }
  } catch (e) {
    toast('初始化失败：' + e.message, 'error', 6000);
    return;
  }
  $('#brandName').textContent = state.settings.shopName || '茶语轩';
  document.title = `${state.settings.shopName || '茶语轩'} · 进销存管理`;
  renderLogo();
  renderStorageStatus();
  bindEvents();
  if (storage.mode === 'disk' && migrated) {
    // 浏览器旧数据 → 服务器存储（一次性导入）
    const ser = await serializeProducts(state.products);
    await persistOp('import', {
      products: ser,
      movements: state.movements,
      settings: state.settings,
      logoPath: state.logoPath || (state.logo ? await uploadImage(state.logo) : null),
    });
    toast(`已将浏览器中的旧数据迁移保存到服务器（${state.products.length} 个商品、${state.movements.length} 条流水）`, 'info', 5000);
  }
  const route = (location.hash || '').replace('#', '');
  showView(['dashboard', 'products', 'purchase', 'sales', 'movements', 'reports', 'settings'].includes(route) ? route : 'dashboard');
}

document.addEventListener('DOMContentLoaded', init);
