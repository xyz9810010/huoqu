const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createSecretBox(base64Key) {
  if (!base64Key) {
    return {
      available: false,
      seal() { throw codedError('PUSH_MASTER_KEY_MISSING', '未配置推送凭据主密钥'); },
      open() { throw codedError('PUSH_MASTER_KEY_MISSING', '未配置推送凭据主密钥'); }
    };
  }
  const key = Buffer.from(String(base64Key), 'base64');
  if (key.length !== 32) throw codedError('PUSH_MASTER_KEY_INVALID', '推送凭据主密钥必须是32字节Base64');

  return {
    available: true,
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    open(value) {
      const parts = String(value || '').split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw codedError('PUSH_SECRET_INVALID', '推送凭据密文格式无效');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        const clear = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
        return JSON.parse(clear.toString('utf8'));
      } catch {
        throw codedError('PUSH_SECRET_DECRYPT_FAILED', '推送凭据无法解密');
      }
    }
  };
}

module.exports = { createSecretBox };
