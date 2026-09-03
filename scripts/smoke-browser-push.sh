#!/usr/bin/env bash
set -euo pipefail

push_smoke_base_url="${PUSH_SMOKE_BASE_URL:-}"
if [[ -z "${push_smoke_base_url}" ]]; then
  printf '%s\n' 'PUSH_SMOKE_BASE_URL is required' >&2
  exit 1
fi
if [[ "${push_smoke_base_url}" != https://* && "${PUSH_SMOKE_ALLOW_HTTP:-0}" != "1" ]]; then
  printf '%s\n' 'PUSH_SMOKE_BASE_URL must use HTTPS' >&2
  exit 1
fi

node <<'NODE'
const baseUrl = process.env.PUSH_SMOKE_BASE_URL.replace(/\/$/, '');
const username = process.env.PUSH_SMOKE_USERNAME || '';
const password = process.env.PUSH_SMOKE_PASSWORD || '';
const requireProvider = process.env.PUSH_SMOKE_REQUIRE_PROVIDER === '1';

async function json(response) {
  const body = await response.json().catch(() => ({}));
  return { response, body: body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body };
}

(async () => {
  const health = await fetch(baseUrl + '/api/health');
  if (!health.ok) throw new Error(`health check failed: ${health.status}`);

  const worker = await fetch(baseUrl + '/push-sw.js');
  if (!worker.ok || !(await worker.text()).includes("addEventListener('push'")) {
    throw new Error('Service Worker asset check failed');
  }

  const unauthorizedKey = await fetch(baseUrl + '/api/v1/notification-providers/web-push/public-key');
  if (unauthorizedKey.status !== 401) throw new Error(`public key auth boundary failed: ${unauthorizedKey.status}`);
  const unauthorizedEvents = await fetch(baseUrl + '/api/v1/events');
  if (unauthorizedEvents.status !== 401) throw new Error(`SSE auth boundary failed: ${unauthorizedEvents.status}`);

  if (username && password) {
    const login = await json(await fetch(baseUrl + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    }));
    if (!login.response.ok || !login.body.token) throw new Error('authenticated smoke login failed');
    const headers = { authorization: `Bearer ${login.body.token}` };

    const key = await fetch(baseUrl + '/api/v1/notification-providers/web-push/public-key', { headers });
    if (requireProvider && key.status !== 200) throw new Error(`Web Push provider is not active: ${key.status}`);
    if (![200, 503].includes(key.status)) throw new Error(`unexpected Web Push config response: ${key.status}`);

    const ticket = await json(await fetch(baseUrl + '/api/v1/events/tickets', { method: 'POST', headers }));
    if (!ticket.response.ok || !ticket.body.ticket) throw new Error('SSE ticket issuance failed');
    const controller = new AbortController();
    const events = await fetch(baseUrl + '/api/v1/events?ticket=' + encodeURIComponent(ticket.body.ticket), {
      signal: controller.signal
    });
    if (!events.ok || !String(events.headers.get('content-type')).includes('text/event-stream')) {
      throw new Error('SSE streaming headers check failed');
    }
    controller.abort();
  }

  console.log('browser-push-smoke=ok');
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
NODE
