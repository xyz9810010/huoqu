// 运维稽核：重复业务单号 / 重复面单号 / 同秒孪生任务（只读，不修改数据）
// 用法：
//   npm run audit:duplicates                 # 默认 data/app.db
//   npm run audit:duplicates -- --db /path/app.db [--json] [--exit-zero]
// 退出码：0=无重复；2=发现重复（--exit-zero 时恒为 0）
'use strict';
const Database = require('better-sqlite3');
const path = require('node:path');
const { auditDuplicates, renderText } = require('../server/operations/duplicate-audit');

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dbPath = path.resolve(flag('--db', process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')));
const asJson = args.includes('--json');
const exitZero = args.includes('--exit-zero');

const db = new Database(dbPath, { readonly: true });
try {
  const findings = auditDuplicates(db);
  if (asJson) {
    console.log(JSON.stringify({ dbPath, found: findings.length, findings }, null, 2));
  } else {
    console.log(`稽核数据库：${dbPath}`);
    console.log(renderText(findings));
  }
  if (findings.length && !exitZero) process.exitCode = 2;
} finally {
  db.close();
}
