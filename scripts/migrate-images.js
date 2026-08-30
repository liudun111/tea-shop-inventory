/* ============================================================
   一次性迁移脚本：把 data.json 中的 Base64 图片分离为独立文件
   用法：node scripts/migrate-images.js
   流程：
     1) 先把 data.json 完整备份到 backups/（带时间戳，绝不覆盖旧备份）
     2) 解码 imageDataUrl / logoDataUrl → 写入 images/ 目录
     3) data.json 中替换为 imagePath / logoPath（原文件已备份，可放心）
     4) 打印迁移前后对比
   （服务启动时也会自动执行同样的迁移；本脚本用于手动触发/复核）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./migrate-lib');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const BACKUPS_DIR = path.join(ROOT, 'backups');

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('未找到 data.json，无需迁移。');
    return;
  }

  // 1. 先备份原文件
  const backupPath = lib.backupFile(DATA_FILE, BACKUPS_DIR, 'pre-image-migration');
  console.log('① 已备份原数据 ->', backupPath);

  // 2. 读取并统计迁移前
  const j = lib.loadJson(DATA_FILE);
  if (!j) {
    console.error('data.json 解析失败，已中止（备份文件保留，未做任何修改）。');
    process.exit(1);
  }
  const beforeProducts = (j.products || []).length;
  const beforeMovements = (j.movements || []).length;
  const beforeImages = (j.products || []).filter(p => p && p.imageDataUrl).length;
  const hasLogo = !!j.logoDataUrl;
  console.log(`② 迁移前：商品 ${beforeProducts} 个，流水 ${beforeMovements} 条，内嵌图片 ${beforeImages} 张，内嵌 Logo ${hasLogo ? '是' : '否'}`);

  // 3. 执行迁移
  const changed = lib.migrateImagesInPlace(j, IMAGES_DIR);
  if (!changed) {
    console.log('③ 未发现内嵌图片（已是新格式），无需迁移。');
    return;
  }

  // 4. 写回 data.json（原子写）
  j.version = 3;
  j.savedAt = new Date().toISOString();
  lib.writeFileAtomic(DATA_FILE, JSON.stringify(j, null, 2));
  console.log('③ 已把图片写入 images/ 目录，data.json 已替换为路径引用（原子写入）。');

  // 5. 迁移后统计
  const after = lib.loadJson(DATA_FILE);
  const afterImages = (after.products || []).filter(p => p && p.imagePath).length;
  const files = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).filter(f => f !== '..' && f !== '.') : [];
  console.log(`④ 迁移后：商品 ${after.products.length} 个，流水 ${(after.movements || []).length} 条，图片文件 ${afterImages} 张，images/ 目录共 ${files.length} 个文件`);
  console.log('完成。原数据备份在：' + backupPath);
}

main();
