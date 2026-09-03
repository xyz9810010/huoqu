#!/usr/bin/env bash
set -euo pipefail

smoke_data_dir="$(mktemp -d -t huoqu-smoke.XXXXXX)"
smoke_backup_dir="$(mktemp -d -t huoqu-backup-smoke.XXXXXX)"
smoke_project="huoqu-smoke"
smoke_container="huoqu-smoke"
smoke_port="${CARGO_SMOKE_PORT:-33000}"
smoke_admin_password="cargo-smoke-admin-password"
smoke_push_key="CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk="

cleanup() {
  CARGO_DATA_DIR="${smoke_data_dir}" \
  CARGO_BACKUP_DIR="${smoke_backup_dir}" \
  CARGO_HTTP_PORT="${smoke_port}" \
  CARGO_CONTAINER_NAME="${smoke_container}" \
    docker compose -p "${smoke_project}" down --remove-orphans >/dev/null 2>&1 || true

  case "${smoke_data_dir}" in
    /tmp/huoqu-smoke.*) rm -rf -- "${smoke_data_dir}" ;;
    *) printf 'refusing to remove unexpected path: %s\n' "${smoke_data_dir}" >&2 ;;
  esac
  case "${smoke_backup_dir}" in
    /tmp/huoqu-backup-smoke.*) rm -rf -- "${smoke_backup_dir}" ;;
    *) printf 'refusing to remove unexpected path: %s\n' "${smoke_backup_dir}" >&2 ;;
  esac
}
trap cleanup EXIT

export CARGO_DATA_DIR="${smoke_data_dir}"
export CARGO_BACKUP_DIR="${smoke_backup_dir}"
export CARGO_HTTP_PORT="${smoke_port}"
export CARGO_CONTAINER_NAME="${smoke_container}"
export INITIAL_ADMIN_PASSWORD="${smoke_admin_password}"
export PUSH_CONFIG_MASTER_KEY="${smoke_push_key}"

docker compose -p "${smoke_project}" up -d --build

for attempt in $(seq 1 60); do
  health="$(docker inspect "${smoke_container}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
  if [[ "${health}" == "healthy" ]]; then break; fi
  if [[ "${attempt}" == "60" ]]; then
    docker compose -p "${smoke_project}" logs --tail=100
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${smoke_port}/api/health" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${smoke_port}/" | grep -q '<div id="app">'

SMOKE_BASE_URL="http://127.0.0.1:${smoke_port}" SMOKE_ADMIN_PASSWORD="${smoke_admin_password}" node -e "
const baseUrl = process.env.SMOKE_BASE_URL;
fetch(baseUrl + '/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: process.env.SMOKE_ADMIN_PASSWORD })
}).then(async response => {
  const body = await response.json();
  if (!response.ok || !body.token) throw new Error('login failed');
  const headers = { authorization: 'Bearer ' + body.token };
  const notifications = await fetch(baseUrl + '/api/v1/notifications?page=1&pageSize=1', { headers });
  const notificationBody = await notifications.json();
  if (!notifications.ok || !notificationBody.data || !Array.isArray(notificationBody.data.items)) {
    throw new Error('notification list failed');
  }
  const ticketResponse = await fetch(baseUrl + '/api/v1/events/tickets', { method: 'POST', headers });
  const ticketBody = await ticketResponse.json();
  if (!ticketResponse.ok || !ticketBody.data || !ticketBody.data.ticket) throw new Error('SSE ticket failed');
  const controller = new AbortController();
  const stream = await fetch(baseUrl + '/api/v1/events?ticket=' + encodeURIComponent(ticketBody.data.ticket), {
    signal: controller.signal
  });
  if (!stream.ok || !String(stream.headers.get('content-type')).includes('text/event-stream')) {
    throw new Error('SSE stream failed');
  }
  controller.abort();
  const logout = await fetch(baseUrl + '/api/logout', {
    method: 'POST',
    headers
  });
  if (!logout.ok) throw new Error('logout failed');
  console.log('auth-smoke=ok');
}).catch(error => {
  console.error(error.message);
  process.exit(1);
});"

docker compose -p "${smoke_project}" restart huoqu
for attempt in $(seq 1 60); do
  health="$(docker inspect "${smoke_container}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
  if [[ "${health}" == "healthy" ]]; then break; fi
  if [[ "${attempt}" == "60" ]]; then exit 1; fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${smoke_port}/api/health" >/dev/null
SMOKE_BASE_URL="http://127.0.0.1:${smoke_port}" SMOKE_ADMIN_PASSWORD="${smoke_admin_password}" node -e "
fetch(process.env.SMOKE_BASE_URL + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: process.env.SMOKE_ADMIN_PASSWORD })
}).then(async response => {
  const body = await response.json();
  if (!response.ok || !body.token) throw new Error('persisted login failed after restart');
  console.log('restart-persistence=ok');
}).catch(error => { console.error(error.message); process.exit(1); });"
docker exec "${smoke_container}" node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/app.db', { readonly: true });
const result = db.pragma('integrity_check', { simple: true });
db.close();
if (result !== 'ok') process.exit(1);
console.log('database-integrity=ok');"

printf '%s\n' 'container-smoke=ok'
