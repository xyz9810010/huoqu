const path = require('node:path');
const fs = require('node:fs');
const { readBackupDatabase } = require('../server/operations/backup');

// 用法: node scripts/restore-data.js <stamp> [目标路径]
// 将某个备份（支持加密备份）解密并校验后写入目标 SQLite 文件。
// 目标路径默认写回 live 数据库 data/app.db（请先停止服务）。
const backupRoot = path.resolve(process.env.BACKUP_ROOT || path.join(process.cwd(), 'backups'));
const stamp = process.argv[2];
const target = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'app.db');

if (!stamp) {
  console.error('用法: node scripts/restore-data.js <stamp> [目标路径]');
  process.exit(1);
}

const backupDir = path.join(backupRoot, stamp);
if (!fs.existsSync(backupDir)) {
  console.error('备份不存在: ' + backupDir);
  process.exit(1);
}

try {
  const plaintext = readBackupDatabase(backupDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, plaintext);
  console.log(JSON.stringify({ restored: stamp, target, bytes: plaintext.length }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
