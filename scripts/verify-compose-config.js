const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
  cwd: process.cwd(),
  encoding: 'utf8'
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

const config = JSON.parse(result.stdout);
const service = config.services?.['huoqu'];
const failures = [];
if (!service) failures.push('huoqu service is missing');
if (!service?.healthcheck?.test) failures.push('healthcheck is missing');
if (service?.init !== true) failures.push('init must be true');
if (!service?.stop_grace_period) failures.push('stop_grace_period is missing');
if (!service?.volumes?.some(volume => volume.target === '/app/data')) failures.push('/app/data mount is missing');
if (!service?.volumes?.some(volume => volume.target === '/app/backups')) failures.push('/app/backups mount is missing');

const httpsResult = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'compose.https.yaml', 'config', '--format', 'json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, CARGO_HTTPS_DOMAIN: 'pickup.example.test' }
});
if (httpsResult.status !== 0) {
  failures.push(`HTTPS compose is invalid: ${httpsResult.stderr.trim()}`);
} else {
const httpsConfig = JSON.parse(httpsResult.stdout);
  const proxy = httpsConfig.services?.['huoqu-proxy'];
  if (!proxy) failures.push('huoqu-proxy service is missing from HTTPS compose');
  if (!proxy?.ports?.some(port => Number(port.target) === 443)) failures.push('HTTPS proxy must expose container port 443');
  if (!proxy?.volumes?.some(volume => volume.target === '/etc/caddy/Caddyfile')) failures.push('Caddyfile mount is missing');
}

try {
  const caddyfile = readFileSync('deploy/Caddyfile', 'utf8');
  if (!/reverse_proxy\s+huoqu:3000/.test(caddyfile)) failures.push('Caddy must reverse proxy huoqu:3000');
  if (!/Strict-Transport-Security/.test(caddyfile)) failures.push('Caddy HSTS header is missing');
} catch (error) {
  failures.push(`Caddyfile cannot be read: ${error.message}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('compose-config=valid');
