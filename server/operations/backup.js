const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  const manifest = {
    stamp,
    createdAt: new Date().toISOString(),
    database: {
      file: 'app.db',
      bytes: fs.statSync(backupDbPath).size,
      sha256: sha256(backupDbPath),
      integrity
    },
    uploads
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { createDataBackup, defaultStamp };
