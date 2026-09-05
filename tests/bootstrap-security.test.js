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
  let exitCode = null;
  child.once('exit', code => { exitCode = code; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && exitCode === null) {
    if (/INITIAL_ADMIN_PASSWORD/.test(output)) {
      // 已出现“必须配置初始密码”的报错，再给进程一小段收尾退出的时间
      await new Promise(resolve => setTimeout(resolve, 250));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (exitCode === null) child.kill();

  assert.notEqual(exitCode, null, 'server unexpectedly started with a fresh database and no bootstrap password');
  assert.match(output, /INITIAL_ADMIN_PASSWORD/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
