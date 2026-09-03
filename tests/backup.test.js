const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createDataBackup } = require('../server/operations/backup');

test('createDataBackup copies a consistent database and uploads without changing source data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dataDir = path.join(root, 'data');
  const backupRoot = path.join(root, 'backups');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, 'proof.txt'), 'pickup-proof');

  const dbPath = path.join(dataDir, 'app.db');
  const source = new Database(dbPath);
  source.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  source.prepare('INSERT INTO sample(value) VALUES (?)').run('original');
  source.close();

  const manifest = await createDataBackup({
    dataDir,
    dbPath,
    backupRoot,
    stamp: '20260902T120000Z'
  });

  assert.equal(manifest.database.integrity, 'ok');
  assert.match(manifest.database.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.uploads.length, 1);
  assert.equal(manifest.uploads[0].file, 'uploads/proof.txt');

  const backupDir = path.join(backupRoot, '20260902T120000Z');
  const backup = new Database(path.join(backupDir, 'app.db'), { readonly: true });
  assert.equal(backup.prepare('SELECT value FROM sample').get().value, 'original');
  backup.close();
  assert.equal(fs.readFileSync(path.join(backupDir, 'uploads', 'proof.txt'), 'utf8'), 'pickup-proof');
  assert.equal(fs.existsSync(path.join(backupDir, 'manifest.json')), true);

  const unchanged = new Database(dbPath, { readonly: true });
  assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM sample').get().count, 1);
  unchanged.close();
});

test('createDataBackup refuses to place backups inside the live data directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-backup-path-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');
  const db = new Database(dbPath);
  db.close();

  await assert.rejects(
    createDataBackup({ dataDir, dbPath, backupRoot: path.join(dataDir, 'backups'), stamp: 'invalid' }),
    /outside the live data directory/
  );
});
