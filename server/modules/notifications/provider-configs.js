function createProviderConfigStore(db, secretBox, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const find = db.prepare('SELECT * FROM push_provider_configs WHERE provider_code=?');

  function getDecrypted(code) {
    const row = find.get(code);
    return row ? secretBox.open(row.credentials_encrypted) : null;
  }

  function publicView(code, schema = []) {
    const row = find.get(code);
    const credentials = row ? secretBox.open(row.credentials_encrypted) : {};
    const fields = {};
    for (const field of schema) {
      const configured = credentials[field.key] !== undefined && credentials[field.key] !== '';
      fields[field.key] = field.secret
        ? { configured, masked: configured ? '••••••' : '' }
        : { configured, value: configured ? credentials[field.key] : '' };
    }
    return {
      code,
      configured: Boolean(row),
      enabled: Boolean(row && row.enabled),
      configVersion: row ? row.config_version : 0,
      testedVersion: row ? row.tested_version : 0,
      healthStatus: row ? row.health_status : 'unconfigured',
      lastTestedAt: row ? row.last_tested_at : '',
      lastErrorCode: row ? row.last_error_code : '',
      fields
    };
  }

  return {
    getDecrypted,
    getActive(code) {
      const row = find.get(code);
      if (!row || !row.enabled || row.health_status !== 'healthy' || row.tested_version !== row.config_version) return null;
      return { code, credentials: secretBox.open(row.credentials_encrypted), configVersion: row.config_version };
    },
    publicView,
    save(code, changes, schema = []) {
      const row = find.get(code);
      const merged = row ? secretBox.open(row.credentials_encrypted) : {};
      const known = new Set(schema.map(field => field.key));
      for (const [key, value] of Object.entries(changes || {})) {
        if (!known.has(key)) throw new Error(`未知的供应商配置字段：${key}`);
        if (value !== '••••••' && value !== undefined) merged[key] = value;
      }
      for (const field of schema) {
        if (field.required && (merged[field.key] === undefined || merged[field.key] === '')) {
          throw new Error(`缺少供应商配置：${field.key}`);
        }
      }
      const timestamp = now();
      const encrypted = secretBox.seal(merged);
      db.prepare(`INSERT INTO push_provider_configs
        (provider_code,credentials_encrypted,enabled,config_version,tested_version,health_status,created_at,updated_at)
        VALUES (?,?,0,1,0,'untested',?,?)
        ON CONFLICT(provider_code) DO UPDATE SET credentials_encrypted=excluded.credentials_encrypted,
          enabled=0,config_version=push_provider_configs.config_version+1,
          health_status='untested',last_error_code='',updated_at=excluded.updated_at`).run(code, encrypted, timestamp, timestamp);
      return publicView(code, schema);
    },
    recordHealth(code, result) {
      const row = find.get(code);
      if (!row) throw new Error('供应商尚未配置');
      const status = result.ok ? 'healthy' : 'failed';
      db.prepare(`UPDATE push_provider_configs SET tested_version=config_version,
        health_status=?,last_tested_at=?,last_error_code=?,updated_at=? WHERE provider_code=?`).run(
          status, now(), result.ok ? '' : String(result.code || 'HEALTH_CHECK_FAILED'), now(), code
        );
      return publicView(code);
    },
    setEnabled(code, enabled) {
      const row = find.get(code);
      if (!row) throw new Error('供应商尚未配置');
      if (enabled && (row.health_status !== 'healthy' || row.tested_version !== row.config_version)) {
        throw new Error('当前配置必须先通过连接测试');
      }
      db.prepare('UPDATE push_provider_configs SET enabled=?,updated_at=? WHERE provider_code=?')
        .run(enabled ? 1 : 0, now(), code);
      const updated = find.get(code);
      return { code, enabled: Boolean(updated.enabled) };
    }
  };
}

module.exports = { createProviderConfigStore };
