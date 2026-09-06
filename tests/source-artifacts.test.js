const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findForbidden } = require('../scripts/check-source-artifacts.js');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huidaiqujian-artifacts-'));
}

test('findForbidden detects generated source files and mobile directories', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'src', 'App.js'), 'generated');
  fs.mkdirSync(path.join(root, 'harmony'));
  fs.writeFileSync(path.join(root, 'web', 'tsconfig.tsbuildinfo'), '{}');

  assert.deepEqual(findForbidden(root).sort(), [
    'harmony',
    'web/src/App.js',
    'web/tsconfig.tsbuildinfo',
  ]);
});

test('findForbidden accepts a clean Web/Node project', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'src', 'App.vue'), '<template />');

  assert.deepEqual(findForbidden(root), []);
});
