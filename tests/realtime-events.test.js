const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRealtimeEventClient,
  createRealtimeEventHub,
  createRealtimeRefreshSubscription,
  isTaskRealtimeEvent,
  notificationFromRealtimeEvent,
  taskIdFromRealtimeEvent,
} = require('../web/src/services/realtime-events.ts');
const { createNotificationSoundController } = require('../web/src/services/notification-sound.ts');

test('canonical realtime notification payload is normalized for UI consumers', () => {
  assert.deepEqual(notificationFromRealtimeEvent({
    version: 1,
    type: 'notification.created',
    data: { notification: {
      id: 'n1', type: 'pickupTask.exception', title: '任务异常', body: '地址有误',
      data: { resourceType: 'pickupTask', resourceId: 't1', route: '/tasks/t1' },
      priority: 'high', createdAt: '2026-09-03T04:00:00.000Z',
    } },
  }), {
    id: 'n1', type: 'pickupTask.exception', title: '任务异常', body: '地址有误',
    data: { resourceType: 'pickupTask', resourceId: 't1', route: '/tasks/t1' },
    priority: 'high', createdAt: '2026-09-03T04:00:00.000Z',
  });
  assert.equal(notificationFromRealtimeEvent({ type: 'task.created' }), null);
});

test('realtime event hub fans out once, deduplicates notifications, and unsubscribes cleanly', () => {
  const hub = createRealtimeEventHub();
  const received = [];
  const unsubscribe = hub.subscribe(event => received.push(event.type));
  const notification = {
    type: 'notification.created',
    data: { notification: { id: 'n1', type: 'pickupTask.assigned', title: '新任务' } },
  };

  assert.equal(hub.publish(notification), true);
  assert.equal(hub.publish(notification), false);
  assert.equal(hub.publish({ type: 'task.created', taskId: 't1' }), true);
  unsubscribe();
  hub.publish({ type: 'task.status', taskId: 't1' });

  assert.deepEqual(received, ['notification.created', 'task.created']);
});

test('task realtime helpers cover canonical notifications and domain events', () => {
  const notification = {
    type: 'notification.created',
    data: { notification: {
      id: 'n1', type: 'pickupTask.assigned', title: '新任务',
      data: { resourceType: 'pickupTask', resourceId: 'task-1' },
    } },
  };
  assert.equal(isTaskRealtimeEvent(notification), true);
  assert.equal(taskIdFromRealtimeEvent(notification), 'task-1');
  assert.equal(isTaskRealtimeEvent({ type: 'task.status', taskId: 'task-2' }), true);
  assert.equal(taskIdFromRealtimeEvent({ type: 'task.status', taskId: 'task-2' }), 'task-2');
  assert.equal(isTaskRealtimeEvent({ type: 'customers.updated' }), false);
});

test('realtime refresh subscription coalesces related events and stops after disposal', () => {
  const hub = createRealtimeEventHub();
  const scheduled = [];
  const cancelled = [];
  let refreshes = 0;
  const subscription = createRealtimeRefreshSubscription({
    hub,
    predicate: isTaskRealtimeEvent,
    refresh: () => { refreshes += 1; },
    schedule: callback => { scheduled.push(callback); return scheduled.length; },
    cancelSchedule: handle => cancelled.push(handle),
    delayMs: 25,
  });

  hub.publish({ type: 'customers.updated' });
  hub.publish({ type: 'task.created', taskId: 't1' });
  hub.publish({ type: 'task.status', taskId: 't1' });
  assert.equal(scheduled.length, 2);
  assert.deepEqual(cancelled, [1]);
  scheduled[1]();
  assert.equal(refreshes, 1);
  subscription.dispose();
  hub.publish({ type: 'task.status', taskId: 't1' });
  assert.equal(scheduled.length, 2);
});

test('foreground notification sound unlocks on user interaction and stays silent in background', async () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const calls = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 10;
      this.destination = {};
    }
    async resume() { this.state = 'running'; calls.push('resume'); }
    createOscillator() {
      return {
        type: '', frequency: { setValueAtTime: (value) => calls.push(['frequency', value]) },
        connect() {}, start: () => calls.push('start'), stop: () => calls.push('stop'),
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
    close() { calls.push('close'); }
  }
  const visibility = { value: 'visible' };
  const sound = createNotificationSoundController({
    eventTarget: target,
    audioContextFactory: () => new FakeAudioContext(),
    visibilityState: () => visibility.value,
  });

  sound.install();
  assert.equal(sound.play(), false);
  await listeners.get('pointerdown')();
  assert.equal(sound.play(), true);
  assert.equal(calls.filter(call => call === 'start').length, 2);
  visibility.value = 'hidden';
  assert.equal(sound.play(), false);
  sound.dispose();
  assert.equal(calls.includes('close'), true);
});

test('realtime client obtains a fresh single-use ticket when reconnecting', async () => {
  const issued = [];
  const sources = [];
  const scheduled = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    close() { this.closed = true; }
  }

  const client = createRealtimeEventClient({
    issueTicket: async () => {
      const ticket = `ticket-${issued.length + 1}`;
      issued.push(ticket);
      return ticket;
    },
    createEventSource: (url) => new FakeEventSource(url),
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelSchedule: () => {},
    reconnectDelayMs: 1,
    onMessage: () => {},
  });

  await client.start();
  assert.equal(sources[0].url, '/api/v1/events?ticket=ticket-1');

  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(scheduled.length, 1);
  await scheduled[0]();

  assert.deepEqual(issued, ['ticket-1', 'ticket-2']);
  assert.equal(sources[1].url, '/api/v1/events?ticket=ticket-2');
});

test('stopping realtime client closes the stream and prevents scheduled reconnect', async () => {
  const scheduled = [];
  let ticketRequests = 0;
  let source;
  const client = createRealtimeEventClient({
    issueTicket: async () => { ticketRequests += 1; return 'one-time-ticket'; },
    createEventSource: () => (source = { closeCalled: false, close() { this.closeCalled = true; } }),
    schedule: (callback) => { scheduled.push(callback); return 1; },
    cancelSchedule: () => {},
    reconnectDelayMs: 1,
    onMessage: () => {},
  });

  await client.start();
  source.onerror();
  client.stop();
  await scheduled[0]();

  assert.equal(source.closeCalled, true);
  assert.equal(ticketRequests, 1);
});
