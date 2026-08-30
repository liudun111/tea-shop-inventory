/* ============================================================
   茶店进销存 · 数据层（IndexedDB 封装）
   纯浏览器本地存储，无需服务器
   ============================================================ */
'use strict';

const DB_NAME = 'teaShopInventoryDB';
const DB_VERSION = 1;

const db = {
  _db: null,

  open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB，请更换 Chrome / Edge / Firefox'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('products')) {
          d.createObjectStore('products', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('movements')) {
          const s = d.createObjectStore('movements', { keyPath: 'id' });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('productId', 'productId', { unique: false });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror = () => reject(req.error || new Error('数据库打开失败'));
      req.onblocked = () => reject(new Error('数据库被其他页面占用，请关闭后重试'));
    });
  },

  /** 通用事务请求：fn 返回一个 IDBRequest */
  _req(mode, storeName, fn) {
    return new Promise((resolve, reject) => {
      if (!this._db) { reject(new Error('数据库未初始化，请刷新页面重试')); return; }
      const t = this._db.transaction(storeName, mode);
      const s = t.objectStore(storeName);
      let result;
      try { result = fn(s); } catch (err) { reject(err); return; }
      // IDBRequest 的 onsuccess 默认是 null（typeof null === 'object'），
      // 所以不能用 typeof xxx === 'function' 判断，改用 addEventListener 识别
      if (result && typeof result.addEventListener === 'function') {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error || new Error('数据库操作失败'));
      } else {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }
    });
  },

  getAll(store) { return this._req('readonly', store, s => s.getAll()); },
  get(store, key) { return this._req('readonly', store, s => s.get(key)); },
  put(store, obj) { return this._req('readwrite', store, s => s.put(obj)); },
  del(store, key) { return this._req('readwrite', store, s => s.delete(key)); },
  clear(store) { return this._req('readwrite', store, s => s.clear()); },

  /** 一次性替换全部数据（用于导入备份） */
  replaceAll({ products, movements, settings }) {
    return new Promise((resolve, reject) => {
      const t = this._db.transaction(['products', 'movements', 'settings'], 'readwrite');
      t.objectStore('products').clear();
      t.objectStore('movements').clear();
      t.objectStore('settings').clear();
      products.forEach(p => t.objectStore('products').put(p));
      movements.forEach(m => t.objectStore('movements').put(m));
      if (settings) t.objectStore('settings').put({ key: 'main', value: settings });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};
