const crypto = require('node:crypto');
const fs = require('node:fs');

// 敏感字段加密（AES-256-GCM）。
// 密钥来源优先级：DATA_ENCRYPTION_KEY_FILE（权限受限文件，Docker secret 风格）
//   → DATA_ENCRYPTION_KEY（环境变量，兼容旧方式）。未配置密钥时全部透传明文（向后兼容）。
const PREFIX = 'enc:v1:';

function loadKey() {
  let raw = '';
  const file = process.env.DATA_ENCRYPTION_KEY_FILE;
  if (file) {
    try { raw = fs.readFileSync(file, 'utf8').trim(); }
    catch (e) { console.error('[secret] DATA_ENCRYPTION_KEY_FILE 读取失败: ' + e.message); }
  } else {
    raw = process.env.DATA_ENCRYPTION_KEY || '';
  }
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY 必须是32字节Base64');
  return key;
}

const KEY = loadKey();

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptField(value) {
  if (value == null) return value;
  const s = String(value);
  if (s === '') return s;
  if (isEncrypted(s)) return s;      // 幂等
  if (!KEY) return s;                 // 未配置密钥：透传明文
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
}

function decryptField(value) {
  if (value == null) return value;
  const s = String(value);
  if (s === '') return s;
  if (!isEncrypted(s)) return s;      // 明文/迁移前数据：原样返回
  if (!KEY) return s;                  // 无密钥：无法解密，原样返回
  const data = Buffer.from(s.slice(PREFIX.length), 'base64url');
  if (data.length < 28) return s;
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ct = data.subarray(28);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return s; // 解密失败（密钥不符/数据损坏）：原样返回，避免崩溃
  }
}

module.exports = { encryptField, decryptField, isEncrypted, available: Boolean(KEY) };
