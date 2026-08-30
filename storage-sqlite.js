/* ============================================================
   SQLite 存储层（Node 内置 node:sqlite，零依赖）
   - WAL 模式
   - 表结构：products / stock / purchases / sales / adjustments / settings
   - 流水表对 (date)、(product_id)、(sale_no) 建索引
   - 库存与流水修改在同一事务内（卖一单 = 减库存 + 记流水，要么全成要么全回滚）
   - 对外暴露与 JSON 后端一致的接口：loadSnapshot() / applyOp() / backupDaily()
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  spec TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  purchase_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  low_stock REAL,
  note TEXT DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  image_path TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS stock (
  product_id TEXT PRIMARY KEY,
  qty REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  party TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  party TEXT DEFAULT '',
  note TEXT DEFAULT '',
  sale_no TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS adjustments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);
CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_sale_no ON sales(sale_no);
CREATE INDEX IF NOT EXISTS idx_adjustments_date ON adjustments(date);
CREATE INDEX IF NOT EXISTS idx_adjustments_product ON adjustments(product_id);
`;

function create({ dbFile, backupDir }) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  /* ---------- 事务辅助 ---------- */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
      throw e;
    }
  }

  /* ---------- 内部操作 ---------- */
  const INSERT_PRODUCT = db.prepare(`INSERT OR REPLACE INTO products
    (id,name,category,spec,unit,purchase_price,sale_price,low_stock,note,hidden,image_path,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const UPSERT_STOCK = db.prepare(`INSERT INTO stock (product_id, qty) VALUES (?, ?)
    ON CONFLICT(product_id) DO UPDATE SET qty = qty + excluded.qty`);
  const ENSURE_STOCK = db.prepare('INSERT OR IGNORE INTO stock (product_id, qty) VALUES (?, 0)');
  const GET_STOCK = db.prepare('SELECT qty FROM stock WHERE product_id = ?');
  const INSERT_PURCHASE = db.prepare(`INSERT INTO purchases
    (id,product_id,quantity,unit_price,total,date,party,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const INSERT_SALE = db.prepare(`INSERT INTO sales
    (id,product_id,quantity,unit_price,cost,total,date,party,note,sale_no,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const INSERT_ADJUST = db.prepare(`INSERT INTO adjustments
    (id,product_id,quantity,date,note,created_at) VALUES (?,?,?,?,?,?)`);
  const GET_PURCHASE = db.prepare('SELECT * FROM purchases WHERE id = ?');
  const GET_SALE = db.prepare('SELECT * FROM sales WHERE id = ?');
  const GET_ADJUST = db.prepare('SELECT * FROM adjustments WHERE id = ?');
  const GET_SETTINGS = db.prepare('SELECT value FROM settings WHERE key = ?');
  const UPSERT_SETTING = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const DEL_SETTING = db.prepare('DELETE FROM settings WHERE key = ?');

  function getAllowNegative() {
    try {
      const row = GET_SETTINGS.get('main');
      if (row) { const s = JSON.parse(row.value); return !!s.allowNegative; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function upsertProduct(p) {
    INSERT_PRODUCT.run(
      p.id, p.name, p.category || '', p.spec || '', p.unit || '',
      p.purchasePrice || 0, p.salePrice || 0,
      p.lowStock == null ? null : p.lowStock,
      p.note || '', p.hidden ? 1 : 0,
      p.imagePath || null, p.createdAt || null, p.updatedAt || null
    );
    ENSURE_STOCK.run(p.id);
  }

  function upsertStockDelta(productId, delta) {
    UPSERT_STOCK.run(productId, delta);
  }

  /* ---------- 逐操作接口（全部在事务内；async 保证返回 Promise） ---------- */
  async function applyOp(op, data) {
    data = data || {};
    switch (op) {
      case 'purchase': {
        const m = data.movement || {};
        if (!m.id || !m.productId) throw new Error('进货参数不完整');
        tx(() => {
          INSERT_PURCHASE.run(m.id, m.productId, m.quantity, m.unitPrice || 0, m.total || 0, m.date, m.party || '', m.note || '', m.createdAt || null);
          upsertStockDelta(m.productId, m.quantity);
          if (m.unitPrice > 0) db.prepare('UPDATE products SET purchase_price = ? WHERE id = ?').run(m.unitPrice, m.productId);
        });
        return { ok: true };
      }
      case 'sale': {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!data.saleNo || !items.length) throw new Error('销售单参数不完整');
        const allowNeg = getAllowNegative();
        tx(() => {
          for (const it of items) {
            if (!it.id || !it.productId) throw new Error('销售明细参数不完整');
            if (!allowNeg) {
              const row = GET_STOCK.get(it.productId);
              const cur = row ? row.qty : 0;
              if (cur < it.quantity) throw new Error('库存不足（商品 ' + it.productId + '，当前 ' + cur + '）');
            }
            INSERT_SALE.run(it.id, it.productId, it.quantity, it.unitPrice || 0, it.cost || 0, it.total || 0,
              data.date, data.party || '', data.note || '', data.saleNo, it.createdAt || null);
            upsertStockDelta(it.productId, -it.quantity);
          }
        });
        return { ok: true };
      }
      case 'adjust': {
        const m = data.movement || {};
        if (!m.id || !m.productId || m.quantity == null) throw new Error('库存调整参数不完整');
        tx(() => {
          INSERT_ADJUST.run(m.id, m.productId, m.quantity, m.date, m.note || '', m.createdAt || null);
          upsertStockDelta(m.productId, m.quantity);
        });
        return { ok: true };
      }
      case 'product_upsert': {
        const p = data.product || {};
        if (!p.id || !p.name) throw new Error('商品参数不完整');
        tx(() => { upsertProduct(p); });
        return { ok: true };
      }
      case 'product_delete': {
        if (!data.id) throw new Error('缺少商品ID');
        tx(() => {
          db.prepare('DELETE FROM products WHERE id = ?').run(data.id);
          db.prepare('DELETE FROM purchases WHERE product_id = ?').run(data.id);
          db.prepare('DELETE FROM sales WHERE product_id = ?').run(data.id);
          db.prepare('DELETE FROM adjustments WHERE product_id = ?').run(data.id);
          db.prepare('DELETE FROM stock WHERE product_id = ?').run(data.id);
        });
        return { ok: true };
      }
      case 'sale_delete': {
        if (!data.saleNo) throw new Error('缺少单号');
        tx(() => {
          const rows = db.prepare('SELECT * FROM sales WHERE sale_no = ?').all(data.saleNo);
          if (!rows.length) throw new Error('未找到该销售单');
          for (const r of rows) upsertStockDelta(r.product_id, r.quantity); // 回补库存
          db.prepare('DELETE FROM sales WHERE sale_no = ?').run(data.saleNo);
        });
        return { ok: true };
      }
      case 'movement_delete': {
        if (!data.id || !data.type) throw new Error('缺少流水ID');
        tx(() => {
          if (data.type === 'in') {
            const r = GET_PURCHASE.get(data.id);
            if (!r) throw new Error('未找到该进货记录');
            upsertStockDelta(r.product_id, -r.quantity);
            db.prepare('DELETE FROM purchases WHERE id = ?').run(data.id);
          } else if (data.type === 'out') {
            const r = GET_SALE.get(data.id);
            if (!r) throw new Error('未找到该销售记录');
            upsertStockDelta(r.product_id, r.quantity);
            db.prepare('DELETE FROM sales WHERE id = ?').run(data.id);
          } else if (data.type === 'adjust') {
            const r = GET_ADJUST.get(data.id);
            if (!r) throw new Error('未找到该调整记录');
            upsertStockDelta(r.product_id, -r.quantity);
            db.prepare('DELETE FROM adjustments WHERE id = ?').run(data.id);
          } else {
            throw new Error('未知流水类型');
          }
        });
        return { ok: true };
      }
      case 'settings': {
        tx(() => {
          UPSERT_SETTING.run('main', JSON.stringify(data.settings || {}));
          if (data.logoPath) UPSERT_SETTING.run('logo_path', data.logoPath);
          else DEL_SETTING.run('logo_path');
        });
        return { ok: true };
      }
      case 'import': {
        const products = Array.isArray(data.products) ? data.products : [];
        const movements = Array.isArray(data.movements) ? data.movements : [];
        tx(() => {
          db.exec('DELETE FROM purchases; DELETE FROM sales; DELETE FROM adjustments; DELETE FROM stock; DELETE FROM products;');
          products.forEach(upsertProduct);
          const net = new Map();
          for (const m of movements) {
            if (m.type === 'in') {
              INSERT_PURCHASE.run(m.id, m.productId, m.quantity, m.unitPrice || 0, m.total || 0, m.date, m.party || '', m.note || '', m.createdAt || null);
              net.set(m.productId, (net.get(m.productId) || 0) + m.quantity);
            } else if (m.type === 'out') {
              INSERT_SALE.run(m.id, m.productId, m.quantity, m.unitPrice || 0, m.cost || 0, m.total || 0, m.date, m.party || '', m.note || '', m.saleNo || '', m.createdAt || null);
              net.set(m.productId, (net.get(m.productId) || 0) - m.quantity);
            } else if (m.type === 'adjust') {
              INSERT_ADJUST.run(m.id, m.productId, m.quantity, m.date, m.note || '', m.createdAt || null);
              net.set(m.productId, (net.get(m.productId) || 0) + m.quantity);
            }
          }
          db.exec('DELETE FROM stock;');
          const ins = db.prepare('INSERT INTO stock (product_id, qty) VALUES (?, ?)');
          for (const [pid, qty] of net) ins.run(pid, qty);
          if (data.settings) UPSERT_SETTING.run('main', JSON.stringify(data.settings));
          if (data.logoPath) UPSERT_SETTING.run('logo_path', data.logoPath);
        });
        return { ok: true };
      }
      case 'clear': {
        tx(() => {
          db.exec('DELETE FROM purchases; DELETE FROM sales; DELETE FROM adjustments; DELETE FROM stock; DELETE FROM products; DELETE FROM settings;');
        });
        return { ok: true };
      }
      default:
        throw new Error('未知操作: ' + op);
    }
  }

  /* ---------- 读取全量快照（与 JSON 后端格式一致） ---------- */
  function loadSnapshot() {
    const products = db.prepare(
      'SELECT id,name,category,spec,unit,purchase_price,sale_price,low_stock,note,hidden,image_path,created_at,updated_at FROM products'
    ).all().map(r => ({
      id: r.id, name: r.name, category: r.category, spec: r.spec, unit: r.unit,
      purchasePrice: r.purchase_price, salePrice: r.sale_price, lowStock: r.low_stock,
      note: r.note, hidden: !!r.hidden, imagePath: r.image_path,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
    const movements = [
      ...db.prepare('SELECT * FROM purchases').all().map(r => ({
        id: r.id, type: 'in', productId: r.product_id, quantity: r.quantity,
        unitPrice: r.unit_price, cost: r.unit_price, total: r.total,
        date: r.date, party: r.party, note: r.note, saleNo: '', createdAt: r.created_at,
      })),
      ...db.prepare('SELECT * FROM sales').all().map(r => ({
        id: r.id, type: 'out', productId: r.product_id, quantity: r.quantity,
        unitPrice: r.unit_price, cost: r.cost, total: r.total,
        date: r.date, party: r.party, note: r.note, saleNo: r.sale_no, createdAt: r.created_at,
      })),
      ...db.prepare('SELECT * FROM adjustments').all().map(r => ({
        id: r.id, type: 'adjust', productId: r.product_id, quantity: r.quantity,
        unitPrice: 0, cost: 0, total: 0,
        date: r.date, party: '', note: r.note, saleNo: '', createdAt: r.created_at,
      })),
    ];
    let settings = null;
    const sRow = GET_SETTINGS.get('main');
    if (sRow) { try { settings = JSON.parse(sRow.value); } catch (e) { settings = null; } }
    const logoRow = GET_SETTINGS.get('logo_path');
    return {
      app: 'teaShopInventory', version: 3,
      savedAt: new Date().toISOString(),
      settings, logoPath: logoRow ? logoRow.value : null,
      products, movements,
    };
  }

  /* ---------- 每日备份（VACUUM INTO 一致性快照） ---------- */
  function backupDaily() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const target = path.join(backupDir, 'data-' + today + '.sqlite');
      if (fs.existsSync(target)) {
        cleanupOldBackups();
        return;
      }
      const safe = target.replace(/\\/g, '/').replace(/'/g, "''");
      db.exec("VACUUM INTO '" + safe + "'");
      console.log('已自动备份 -> ' + target);
      cleanupOldBackups();
    } catch (e) { console.error('SQLite 备份失败:', e.message); }
  }

  function cleanupOldBackups() {
    try {
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      fs.readdirSync(backupDir).forEach(f => {
        const m = f.match(/^data-(\d{4}-\d{2}-\d{2})\.sqlite$/);
        if (m) {
          const t = new Date(m[1]).getTime();
          if (!isNaN(t) && t < cutoff) { fs.unlinkSync(path.join(backupDir, f)); console.log('已清理 30 天前的旧备份:', f); }
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 各表记录数（迁移核对用） ---------- */
  function counts() {
    const c = sql => db.prepare('SELECT COUNT(*) AS n FROM ' + sql).get().n;
    return {
      products: c('products'),
      stock: c('stock'),
      purchases: c('purchases'),
      sales: c('sales'),
      adjustments: c('adjustments'),
      settings: c('settings'),
    };
  }

  return {
    loadSnapshot,
    applyOp,
    backupDaily,
    counts,
    close: () => { try { db.close(); } catch (e) { /* 忽略 */ } },
    raw: db,
  };
}

/* ---------- 从 data.json 一次性迁移（供脚本与服务器启动共用） ---------- */
function migrateFromJson(dataFile, dbFile, backupDir) {
  const lib = require('./scripts/migrate-lib');
  if (!fs.existsSync(dataFile)) { console.log('未找到 ' + dataFile + '，跳过迁移。'); return null; }
  const backup = lib.backupFile(dataFile, backupDir, 'pre-sqlite-migration');
  console.log('① 已备份原 data.json ->', backup);
  const j = lib.loadJson(dataFile);
  if (!j) { console.error('data.json 解析失败，迁移中止（已备份）。'); throw new Error('data.json 解析失败'); }

  console.log('② 迁移前（data.json）：商品 ' + (j.products || []).length + ' 个，流水 ' + (j.movements || []).length + ' 条');

  const backend = create({ dbFile, backupDir });
  const before = backend.counts();
  backend.applyOp('import', {
    products: j.products || [],
    movements: j.movements || [],
    settings: j.settings || null,
    logoPath: j.logoPath || null,
  });
  const after = backend.counts();
  backend.close();

  console.log('③ 迁移后（SQLite ' + path.basename(dbFile) + '）：');
  console.log('   商品表 products    : ' + before.products + ' → ' + after.products + ' 行');
  console.log('   库存表 stock       : ' + before.stock + ' → ' + after.stock + ' 行');
  console.log('   进货流水 purchases : ' + before.purchases + ' → ' + after.purchases + ' 行');
  console.log('   销售流水 sales     : ' + before.sales + ' → ' + after.sales + ' 行');
  console.log('   调整流水 adjustments: ' + before.adjustments + ' → ' + after.adjustments + ' 行');
  console.log('   设置表 settings    : ' + before.settings + ' → ' + after.settings + ' 行');
  console.log('④ 原 data.json 已保留（未删除）。');
  return after;
}

module.exports = { create, migrateFromJson };
