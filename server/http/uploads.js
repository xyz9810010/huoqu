// 上传处理器（v1 / v2 共用）：upload 用于 Excel 导入，imageUpload 用于图片落盘
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('node:crypto');

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };

function createUploader(uploadsDir) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const imageUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => cb(null, randomUUID() + (IMAGE_EXT[file.mimetype] || '.jpg'))
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('仅支持图片文件')))
  });
  return { upload, imageUpload };
}

module.exports = { createUploader, IMAGE_EXT };
