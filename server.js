/* ============================================================
   茶店进销存 · 本地服务器（零依赖）
   存储后端（二选一）：
   - SQLite（默认）：storage-sqlite.js，WAL 模式，库存与流水同事务，逐操作写入
   - JSON（回退）：storage-json.js，原子写 + 串行队列，与 SQLite 同一套操作接口
   环境变量 STORAGE=json 可强制使用 JSON 后端（一键回退）。
   其他职责：图片上传、每日自动备份、启动自动迁移（图片分离 + JSON→SQLite）。
   用法：node server.js  （或双击 start.bat）
   访问：http://localhost:8080
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const migrateLib = require('./scripts/migrate-lib');

const PORT = 8080;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const DB_FILE = path.join(ROOT, 'data.sqlite');
const IMAGES_DIR = path.join(ROOT, 'images');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const MAX_JSON = 64 * 1024 * 1024;    // 兼容旧的全量快照导入
const MAX_IMAGE = 15 * 1024 * 1024;   // 单张图片最大 15MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sqlite': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ================= 存储后端选择 ================= */

let backend = null;
let backendName = 'json';

function initBackend() {
  // 1) 先做 data.json 图片分离（无论后端），保证 SQLite 迁移时已是路径引用
  autoMigrateImages();

  const forceJson = process.env.STORAGE === 'json';
  if (!forceJson) {
    try {
      const sqlite = require('./storage-sqlite');
      // 若尚无 SQLite 库且存在 data.json → 一次性迁移（自动备份 + 打印各表记录数）
      if (!fs.existsSync(DB_FILE) && fs.existsSync(DATA_FILE)) {
        console.log('检测到 data.json 但尚无 SQLite 数据库，开始一次性迁移...');
        sqlite.migrateFromJson(DATA_FILE, DB_FILE, BACKUPS_DIR);
      }
      backend = sqlite.create({ dbFile: DB_FILE, backupDir: BACKUPS_DIR });
      backendName = 'sqlite';
      console.log('存储后端：SQLite（WAL 模式） ' + DB_FILE);
    } catch (e) {
      console.error('SQLite 后端不可用，回退到 JSON 后端：' + e.message);
      backend = null;
    }
  }
  if (!backend) {
    const jsonStore = require('./storage-json');
    backend = jsonStore.create({ dataFile: DATA_FILE, backupDir: BACKUPS_DIR });
    backendName = 'json';
    console.log('存储后端：JSON 文件 ' + DATA_FILE);
  }
}

/* 启动自动迁移：data.json 中残留的 Base64 图片 → images/ 独立文件（先备份） */
function autoMigrateImages() {
  const j = migrateLib.loadJson(DATA_FILE);
  if (!j) return;
  if (!migrateLib.hasEmbeddedImages(j)) return;
  const backup = migrateLib.backupFile(DATA_FILE, BACKUPS_DIR, 'pre-image-migration');
  console.log('检测到旧格式（Base64 图片），开始迁移，原数据已备份 ->', backup);
  const changed = migrateLib.migrateImagesInPlace(j, IMAGES_DIR);
  if (changed) {
    j.version = 3;
    j.savedAt = new Date().toISOString();
    migrateLib.writeFileAtomic(DATA_FILE, JSON.stringify(j, null, 2));
    console.log('图片已分离到 images/ 目录。');
  }
}

/* ================= HTTP 辅助 ================= */

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > limit) { cb(new Error('数据过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(e); }
  });
  req.on('error', e => cb(e));
}

function readRawBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > limit) { cb(new Error('数据过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', e => cb(e));
}

/* ================= HTTP 服务 ================= */

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }

  // ==== 健康检查 ====
  if (urlPath === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, storage: 'disk', backend: backendName, dataFile: DATA_FILE, dbFile: DB_FILE });
    return;
  }

  // ==== 读取全量数据（页面启动加载） ====
  if (urlPath === '/api/data' && req.method === 'GET') {
    try {
      const d = backend.loadSnapshot();
      sendJson(res, 200, d || { products: [], movements: [], settings: null, logoPath: null, savedAt: null });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: '读取数据失败: ' + e.message });
    }
    return;
  }

  // ==== 逐操作写入（每个操作一个事务/一次原子写） ====
  if (urlPath === '/api/op' && req.method === 'POST') {
    readJsonBody(req, MAX_JSON, (err, body) => {
      if (err || !body || !body.op) { sendJson(res, 400, { ok: false, error: '请求格式错误' }); return; }
      backend.applyOp(body.op, body.data || {})
        .then(() => sendJson(res, 200, { ok: true }))
        .catch(e => sendJson(res, 400, { ok: false, error: e.message }));
    });
    return;
  }

  // ==== 兼容旧客户端：全量快照导入（等价于 import 操作） ====
  if (urlPath === '/api/data' && req.method === 'POST') {
    readJsonBody(req, MAX_JSON, (err, obj) => {
      if (err || !obj || !Array.isArray(obj.products) || !Array.isArray(obj.movements)) {
        sendJson(res, 400, { ok: false, error: '数据格式错误' });
        return;
      }
      backend.applyOp('import', {
        products: obj.products, movements: obj.movements,
        settings: obj.settings || null, logoPath: obj.logoPath || null,
      }).then(() => sendJson(res, 200, { ok: true }))
        .catch(e => sendJson(res, 500, { ok: false, error: '写入失败: ' + e.message }));
    });
    return;
  }

  // ==== 上传图片：存为 images/ 独立文件，返回相对路径 ====
  if (urlPath === '/api/image' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    readRawBody(req, MAX_IMAGE, (err, buf) => {
      if (err || !buf || !buf.length) { sendJson(res, 400, { ok: false, error: '图片数据无效' }); return; }
      try {
        const extMatch = /^image\/(jpeg|png|webp|gif)/.exec(contentType);
        const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'jpg';
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
        const name = crypto.randomUUID() + '.' + ext;
        const file = path.join(IMAGES_DIR, name);
        const tmp = file + '.tmp';
        const fd = fs.openSync(tmp, 'w');
        try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
        sendJson(res, 200, { ok: true, path: 'images/' + name });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '图片保存失败: ' + e.message });
      }
    });
    return;
  }

  // ==== 静态文件（含 images/ 目录） ====
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ================= 启动 ================= */

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
initBackend();
backend.backupDaily();
setInterval(() => backend.backupDaily(), 24 * 3600 * 1000);

server.listen(PORT, () => {
  console.log('茶店进销存已启动：http://localhost:' + PORT);
  console.log('存储后端：' + (backendName === 'sqlite' ? 'SQLite（WAL）' : 'JSON 文件'));
  console.log('图片目录：' + IMAGES_DIR);
  console.log('备份目录：' + BACKUPS_DIR + '（每日自动备份，保留 30 天）');
  console.log('按 Ctrl+C 停止服务');
  if (process.platform === 'win32' && !process.env.NO_OPEN) {
    exec('start http://localhost:' + PORT, () => {});
  }
});
