const path = require('node:path');
const { createDataBackup } = require('../server/operations/backup');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const dbPath = path.resolve(process.env.DB_PATH || path.join(dataDir, 'app.db'));
const backupRoot = path.resolve(process.env.BACKUP_ROOT || path.join(process.cwd(), 'backups'));
const stamp = process.argv[2];

createDataBackup({ dataDir, dbPath, backupRoot, stamp })
  .then(manifest => {
    console.log(JSON.stringify({
      backup: manifest.stamp,
      integrity: manifest.database.integrity,
      databaseSha256: manifest.database.sha256,
      uploadFiles: manifest.uploads.length
    }));
  })
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
