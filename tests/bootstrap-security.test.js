const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a fresh installation refuses to create a known default administrator password', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-bootstrap-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DB_PATH: path.join(tempDir, 'app.db'),
      PORT: '0',
      DISABLE_PUSH: '1',
      INITIAL_ADMIN_PASSWORD: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exitCode = await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => { child.kill(); resolve(null); }, 1200))
  ]);

  assert.notEqual(exitCode, null, 'server unexpectedly started with a fresh database and no bootstrap password');
  assert.match(output, /INITIAL_ADMIN_PASSWORD/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
