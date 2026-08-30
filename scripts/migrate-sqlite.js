/* ============================================================
   一次性迁移脚本：data.json → SQLite（data.sqlite）
   用法：node scripts/migrate-sqlite.js
   流程：
     1) 先把 data.json 完整备份到 backups/（带时间戳）
     2) 创建 SQLite 数据库（WAL 模式），建表并导入
     3) 迁移前后打印各表记录数供核对
     4) 原 data.json 保留不删除
   （服务器启动时检测到 data.sqlite 不存在也会自动执行同样的迁移）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite = require('../storage-sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const DB_FILE = path.join(ROOT, 'data.sqlite');
const BACKUPS_DIR = path.join(ROOT, 'backups');

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('未找到 data.json，无需迁移。');
    return;
  }
  if (fs.existsSync(DB_FILE)) {
    console.log('data.sqlite 已存在。若确实要重新迁移，请先删除或改名 data.sqlite 后重试。');
    console.log('（为避免误覆盖，本脚本不会覆盖已有数据库）');
    process.exit(1);
  }
  sqlite.migrateFromJson(DATA_FILE, DB_FILE, BACKUPS_DIR);
  console.log('迁移完成。data.json 已保留；现在可用 start.bat 启动（自动使用 SQLite）。');
}

main();
