const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const forbiddenRootEntries = [
  'android',
  'harmony',
  '_h3',
  '_h4',
  '_h5',
  'archives',
  'audit-ui',
];

function findForbidden(root = projectRoot) {
  const forbidden = [];
  const sourceDir = path.join(root, 'web', 'src');

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.js.map'))) {
        forbidden.push(path.relative(root, fullPath));
      }
    }
  }

  walk(sourceDir);
  const buildInfo = path.join(root, 'web', 'tsconfig.tsbuildinfo');
  if (fs.existsSync(buildInfo)) forbidden.push(path.relative(root, buildInfo));

  for (const entry of forbiddenRootEntries) {
    if (fs.existsSync(path.join(root, entry))) forbidden.push(entry);
  }

  return forbidden.sort();
}

if (require.main === module) {
  const forbidden = findForbidden();
  if (forbidden.length > 0) {
    console.error('Forbidden source artifacts found:');
    for (const file of forbidden) console.error(`- ${file}`);
    process.exit(1);
  }
  console.log('source-artifacts=clean');
}

module.exports = { findForbidden };
