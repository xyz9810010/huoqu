function createProviderRegistry(initialAdapters = []) {
  const adapters = new Map();

  function register(adapter) {
    if (!adapter || !/^[a-z][a-z0-9_]*$/.test(String(adapter.code || ''))) {
      throw new Error('推送供应商 code 格式不正确');
    }
    if (adapters.has(adapter.code)) throw new Error(`推送供应商重复注册：${adapter.code}`);
    for (const method of ['validateConfig', 'send', 'normalizeError', 'healthCheck']) {
      if (typeof adapter[method] !== 'function') throw new Error(`推送供应商缺少 ${method}`);
    }
    adapters.set(adapter.code, adapter);
    return adapter;
  }

  for (const adapter of initialAdapters) register(adapter);

  return {
    register,
    get(code) { return adapters.get(code) || null; },
    list() {
      return Array.from(adapters.values()).map(adapter => ({
        code: adapter.code,
        displayName: adapter.displayName,
        platforms: adapter.platforms || [],
        credentialSchema: adapter.credentialSchema || [],
        capabilities: adapter.capabilities || {}
      }));
    }
  };
}

module.exports = { createProviderRegistry };
