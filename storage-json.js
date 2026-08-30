/* ============================================================
   JSON 存储层（回退方案，保持与 SQLite 后端相同的逐操作接口）
   - 数据保存在 data.json（图片为 images/ 路径引用）
   - 所有写操作经进程内串行队列 + 原子写入（tmp + fsync + rename）
   - 库存由流水推导，库存校验在操作内完成
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function create({ dataFile, backupDir }) {
  let data = null;

  /* ---------- 文件读写 ---------- */
  function readFile() {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const j = JSON.parse(raw);
      return j && Array.isArray(j.products) && Array.isArray(j.movements) ? j : null;
    } catch (e) { return null; }
  }
  function writeFile() {
    const json = JSON.stringify(data, null, 2);
    const tmp = dataFile + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, json, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dataFile);
  }

  /* 写串行队列 */
  let chain = Promise.resolve();
  function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  /* 内存中应用操作后统一落盘（在 serial 内执行） */
  function mutate(fn) {
    if (!data) data = { app: 'teaShopInventory', version: 3, savedAt: null, settings: null, logoPath: null, products: [], movements: [] };
    fn(data);
    data.savedAt = new Date().toISOString();
    writeFile();
  }

  function stockOf(movements, productId) {
    return movements.reduce((s, m) => m.productId === productId ? s + (m.type === 'out' ? -m.quantity : m.quantity) : s, 0);
  }

  /* ---------- 逐操作接口（与 SQLite 后端语义一致） ---------- */
  function applyOp(op, d) {
    d = d || {};
    return serial(() => {
      if (!data) data = readFile() || { app: 'teaShopInventory', version: 3, savedAt: null, settings: null, logoPath: null, products: [], movements: [] };
      switch (op) {
        case 'purchase': {
          const m = d.movement || {};
          if (!m.id || !m.productId) throw new Error('进货参数不完整');
          mutate(store => {
            store.movements.push(m);
            if (m.unitPrice > 0) {
              const p = store.products.find(x => x.id === m.productId);
              if (p) p.purchasePrice = m.unitPrice;
            }
          });
          break;
        }
        case 'sale': {
          const items = Array.isArray(d.items) ? d.items : [];
          if (!d.saleNo || !items.length) throw new Error('销售单参数不完整');
          const allowNeg = (data.settings && data.settings.allowNegative) || false;
          // 库存校验（用当前文件中的流水推导）
          for (const it of items) {
            if (!allowNeg) {
              const cur = stockOf(data.movements, it.productId);
              if (cur < it.quantity) throw new Error('库存不足（商品 ' + it.productId + '，当前 ' + cur + '）');
            }
          }
          mutate(store => {
            items.forEach(it => store.movements.push(it));
          });
          break;
        }
        case 'adjust': {
          const m = d.movement || {};
          if (!m.id || !m.productId || m.quantity == null) throw new Error('库存调整参数不完整');
          mutate(store => { store.movements.push(m); });
          break;
        }
        case 'product_upsert': {
          const p = d.product || {};
          if (!p.id || !p.name) throw new Error('商品参数不完整');
          mutate(store => {
            const idx = store.products.findIndex(x => x.id === p.id);
            if (idx >= 0) store.products[idx] = p;
            else store.products.push(p);
          });
          break;
        }
        case 'product_delete': {
          if (!d.id) throw new Error('缺少商品ID');
          mutate(store => {
            store.products = store.products.filter(x => x.id !== d.id);
            store.movements = store.movements.filter(m => m.productId !== d.id);
          });
          break;
        }
        case 'sale_delete': {
          if (!d.saleNo) throw new Error('缺少单号');
          mutate(store => {
            const rows = store.movements.filter(m => m.type === 'out' && m.saleNo === d.saleNo);
            if (!rows.length) throw new Error('未找到该销售单');
            store.movements = store.movements.filter(m => !(m.type === 'out' && m.saleNo === d.saleNo));
          });
          break;
        }
        case 'movement_delete': {
          if (!d.id || !d.type) throw new Error('缺少流水ID');
          mutate(store => {
            const idx = store.movements.findIndex(m => m.id === d.id);
            if (idx < 0) throw new Error('未找到该流水');
            store.movements.splice(idx, 1);
          });
          break;
        }
        case 'settings': {
          mutate(store => { store.settings = d.settings || {}; store.logoPath = d.logoPath || null; });
          break;
        }
        case 'import': {
          mutate(store => {
            store.products = Array.isArray(d.products) ? d.products : [];
            store.movements = Array.isArray(d.movements) ? d.movements : [];
            store.settings = d.settings || {};
            store.logoPath = d.logoPath || null;
          });
          break;
        }
        case 'clear': {
          mutate(store => {
            store.products = []; store.movements = []; store.settings = {}; store.logoPath = null;
          });
          break;
        }
        default:
          throw new Error('未知操作: ' + op);
      }
      return { ok: true };
    });
  }

  function loadSnapshot() {
    if (!data) data = readFile() || { app: 'teaShopInventory', version: 3, savedAt: null, settings: null, logoPath: null, products: [], movements: [] };
    return data;
  }

  function backupDaily() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      if (!fs.existsSync(dataFile)) return;
      const today = new Date().toISOString().slice(0, 10);
      const target = path.join(backupDir, 'data.json-' + today);
      if (!fs.existsSync(target)) { fs.copyFileSync(dataFile, target); console.log('已自动备份 -> ' + target); }
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      fs.readdirSync(backupDir).forEach(f => {
        const m = f.match(/^data\.json-(\d{4}-\d{2}-\d{2})$/);
        if (m) {
          const t = new Date(m[1]).getTime();
          if (!isNaN(t) && t < cutoff) { fs.unlinkSync(path.join(backupDir, f)); console.log('已清理 30 天前的旧备份:', f); }
        }
      });
    } catch (e) { console.error('JSON 备份失败:', e.message); }
  }

  function counts() {
    const d = loadSnapshot();
    return {
      products: d.products.length,
      stock: new Set(d.products.map(p => p.id)).size,
      purchases: d.movements.filter(m => m.type === 'in').length,
      sales: d.movements.filter(m => m.type === 'out').length,
      adjustments: d.movements.filter(m => m.type === 'adjust').length,
      settings: d.settings ? 1 : 0,
    };
  }

  return { loadSnapshot, applyOp, backupDaily, counts, close: () => {} };
}

module.exports = { create };
