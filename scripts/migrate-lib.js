/* ============================================================
   图片迁移共用库（供 server.js 启动自动迁移 与 scripts/migrate-images.js 共用）
   功能：
   - 把 data.json 里的 Base64 图片（imageDataUrl / logoDataUrl）解码为
     images/ 目录下的独立文件，JSON 中替换为相对路径（imagePath / logoPath）
   安全要求：所有操作前先备份原文件
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** 解析 dataURL，返回 { mime, ext, buffer }；解析失败返回 null */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);          // 形如 image/jpeg;base64
  const mime = meta.split(';')[0];
  if (!mime.startsWith('image/')) return null;
  const isBase64 = /;base64$/i.test(meta);
  const payload = dataUrl.slice(comma + 1);
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf8');
  return { mime, ext: EXT_BY_MIME[mime] || 'bin', buffer };
}

/** 读取 JSON 文件，解析失败返回 null */
function loadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 原子写文件（tmp + rename） */
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 把 dataUrl 保存为 imagesDir 下的文件（原子写）。
 * @returns 保存的文件名（如 CY0001.jpg）；失败返回 null
 */
function saveDataUrlToFile(dataUrl, imagesDir, baseName) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || !parsed.buffer.length) return null;
  fs.mkdirSync(imagesDir, { recursive: true });
  const safeBase = String(baseName || 'img').replace(/[^\w.-]/g, '_');
  const fileName = safeBase + '.' + parsed.ext;
  writeFileAtomic(path.join(imagesDir, fileName), parsed.buffer);
  return fileName;
}

/**
 * 原地迁移一个数据对象中的图片字段（Base64 → 文件路径）。
 * @returns 是否发生了变更
 */
function migrateImagesInPlace(j, imagesDir) {
  if (!j || typeof j !== 'object') return false;
  let changed = false;

  if (Array.isArray(j.products)) {
    j.products.forEach(p => {
      if (p && p.imageDataUrl) {
        const fileName = saveDataUrlToFile(p.imageDataUrl, imagesDir, p.id || 'product');
        if (fileName) {
          p.imagePath = 'images/' + fileName;
          delete p.imageDataUrl;
          changed = true;
        }
      }
    });
  }

  if (j.logoDataUrl) {
    const fileName = saveDataUrlToFile(j.logoDataUrl, imagesDir, 'logo');
    if (fileName) {
      j.logoPath = 'images/' + fileName;
      delete j.logoDataUrl;
      changed = true;
    }
  }
  return changed;
}

/**
 * 备份文件到备份目录，文件名带时间戳标签，返回备份路径；失败返回 null。
 */
function backupFile(file, backupsDir, tag) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(backupsDir, `${path.basename(file)}.${tag || 'bak'}-${stamp}`);
  fs.copyFileSync(file, target);
  return target;
}

/** 检查数据对象是否仍含 Base64 图片（需要迁移） */
function hasEmbeddedImages(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.logoDataUrl) return true;
  return Array.isArray(j.products) && j.products.some(p => p && p.imageDataUrl);
}

module.exports = {
  parseDataUrl,
  loadJson,
  writeFileAtomic,
  saveDataUrlToFile,
  migrateImagesInPlace,
  backupFile,
  hasEmbeddedImages,
};
