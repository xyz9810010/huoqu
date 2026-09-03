const test = require('node:test');
const assert = require('node:assert/strict');

const { createRequestLogger, redactUrl } = require('../server/http/request-logger');

test('redactUrl removes every sensitive query value but preserves routing data', () => {
  assert.equal(
    redactUrl('/api/events?token=session-secret&ticket=event-secret&x=1'),
    '/api/events?token=%5BREDACTED%5D&ticket=%5BREDACTED%5D&x=1'
  );
});

test('request logger never writes URL credentials', () => {
  const lines = [];
  const logger = createRequestLogger({ write: line => lines.push(line), now: () => new Date('2026-09-02T06:00:00Z') });
  logger({ ip: '::ffff:192.0.2.5', method: 'GET', originalUrl: '/api/events?token=session-secret' }, {}, () => {});

  assert.equal(lines.length, 1);
  assert.match(lines[0], /192\.0\.2\.5 GET \/api\/events\?token=%5BREDACTED%5D/);
  assert.doesNotMatch(lines[0], /session-secret/);
});
