const { randomBytes } = require('node:crypto');

function generatePushMasterKey() {
  return randomBytes(32).toString('base64');
}

if (require.main === module) {
  process.stdout.write(generatePushMasterKey() + '\n');
}

module.exports = { generatePushMasterKey };
