const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// 备份加密密钥（BACKUP_ENCRYPTION_KEY，base64 32 字节）；未配置则明文备份
function backupEncryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY 必须是32字节Base64');
  return key;
}

// AES-256-GCM 加密：IV(12) + authTag(16) + 密文
function encryptBuffer(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptBuffer(data, key) {
  if (data.length < 28) throw new Error('密文长度无效');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function listFiles(rootDir, relativeDir = '') {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(rootDir, relativePath));
    if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function assertBackupRoot(dataDir, backupRoot) {
  const data = path.resolve(dataDir);
  const backups = path.resolve(backupRoot);
  if (backups === data || backups.startsWith(data + path.sep)) {
    throw new Error('backupRoot must be outside the live data directory');
  }
}

function defaultStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function createDataBackup(options) {
  const dataDir = path.resolve(options.dataDir);
  const dbPath = path.resolve(options.dbPath);
  const backupRoot = path.resolve(options.backupRoot);
  const stamp = options.stamp || defaultStamp();
  assertBackupRoot(dataDir, backupRoot);
  if (!fs.existsSync(dbPath)) throw new Error(`database does not exist: ${dbPath}`);
  if (!/^[A-Za-z0-9._-]+$/.test(stamp)) throw new Error('backup stamp contains unsafe characters');

  const backupDir = path.join(backupRoot, stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: false });

  const backupDbPath = path.join(backupDir, 'app.db');
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupDbPath);
  } finally {
    source.close();
  }

  const backup = new Database(backupDbPath, { readonly: true, fileMustExist: true });
  const integrity = backup.pragma('integrity_check', { simple: true });
  backup.close();
  if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);

  // 备份加密：配置了 BACKUP_ENCRYPTION_KEY 则对数据库文件做 AES-256-GCM 加密
  const encKey = backupEncryptionKey();
  const plainSha256 = sha256(backupDbPath);
  let databaseFile = 'app.db';
  let cipherSha256 = null;
  if (encKey) {
    const encrypted = encryptBuffer(fs.readFileSync(backupDbPath), encKey);
    fs.writeFileSync(backupDbPath + '.enc', encrypted);
    fs.unlinkSync(backupDbPath);
    databaseFile = 'app.db.enc';
    cipherSha256 = sha256(backupDbPath + '.enc');
  }

  const sourceUploads = path.join(dataDir, 'uploads');
  const backupUploads = path.join(backupDir, 'uploads');
  if (fs.existsSync(sourceUploads)) fs.cpSync(sourceUploads, backupUploads, { recursive: true });

  const uploads = listFiles(backupDir, 'uploads').map(file => {
    const filePath = path.join(backupDir, file);
    return {
      file: file.split(path.sep).join('/'),
      bytes: fs.statSync(filePath).size,
      sha256: sha256(filePath)
    };
  });
  const finalDbPath = path.join(backupDir, databaseFile);
  const database = {
    file: databaseFile,
    bytes: fs.statSync(finalDbPath).size,
    sha256: plainSha256,
    integrity
  };
  if (cipherSha256) database.cipherSha256 = cipherSha256;
  const manifest = {
    stamp,
    createdAt: new Date().toISOString(),
    encrypted: Boolean(encKey),
    database,
    uploads
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// 读取备份中的数据库明文（自动按 manifest 解密并校验 sha256）
function readBackupDatabase(backupDir) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dbFile = manifest.database && manifest.database.file;
  if (!dbFile) throw new Error('manifest.database.file missing');
  const dbFilePath = path.join(backupDir, dbFile);
  if (!fs.existsSync(dbFilePath)) throw new Error('database file not found: ' + dbFile);
  let plaintext = fs.readFileSync(dbFilePath);
  if (manifest.encrypted) {
    const key = backupEncryptionKey();
    if (!key) throw new Error('备份已加密，但未配置 BACKUP_ENCRYPTION_KEY');
    plaintext = decryptBuffer(plaintext, key);
  }
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (hash !== manifest.database.sha256) throw new Error('备份校验失败：sha256 不匹配');
  return plaintext;
}

module.exports = { createDataBackup, defaultStamp, decryptBuffer, backupEncryptionKey, readBackupDatabase };
