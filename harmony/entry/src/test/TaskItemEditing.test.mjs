// Runs compiler-generated page/API code with only platform and HTTP boundaries stubbed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const cache = 'entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/';
const pageCode = readFileSync(cache + 'pages/TaskDetailPage.ts', 'utf8').replace(/^import .*;\r?\n/gm, '');
const apiCode = readFileSync(cache + 'api/TaskApi.ts', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class TaskApi', 'class TaskApi');
const item = { id: 'item-1', taskId: 'task-1', workerId: 'w1', workerName: '取件员', entryMethod: 'manual',
  waybillNo: 'WB-1', goodsName: '服装', pieces: 2, sortOrder: 0, finalWeight: 0, weightSource: '', matchStatus: 'pending', createdAt: '', updatedAt: '' };
const task = { id: 'task-1', status: 'completed', items: [item], photos: [], exceptions: [], workers: [],
  pickupNote: '', internalNote: '', taskType: 'normal' };
function fixture(client = {}) {
  const texts = [], buttons = [], keys = [], toasts = [];
  const noop = () => {};
  const ui = new Proxy({}, { get: () => noop });
  class State { constructor(v) { this.v = v; } get() { return this.v; } set(v) { this.v = v; } }
  class ViewPU {
    static create() {} finalizeConstruction() {}
    observeComponentCreation2(f) { f(0, true); }
    ifElseBranchUpdateFunction(id, f) { f(); }
    forEachUpdateFunction(id, items, render, key) { items.forEach((i, index) => { keys.push(key(i, index)); render(i); }); }
    updateStateVarsOfChildByElmtId() {}
  }
  const context = {
    ViewPU, ObservedPropertyObjectPU: State, ObservedPropertySimplePU: State,
    registerNamedRoute: noop, RefreshIconButton: class {}, ApiClient: client,
    UiUtil: { toast: message => toasts.push(message) }, SessionStore: { getUser: () => ({ role: 'worker' }) },
    taskStatusLabel: v => v, fmtTime: v => v, entryMethodLabel: v => v, matchStatusLabel: v => v, normalizeRole: v => v,
    Text: new Proxy({}, { get: (_, k) => k === 'create' ? v => texts.push(v) : noop }),
    Button: new Proxy({}, { get: (_, k) => k === 'createWithLabel' ? v => buttons.push(v) : noop })
  };
  for (const name of ['Column', 'Row', 'Blank', 'Scroll', 'If', 'ForEach', 'LoadingProgress', 'Stack', 'TextInput',
    'FontWeight', 'TextAlign', 'Alignment', 'FlexAlign', 'HorizontalAlign', 'InputType', 'Color']) context[name] = ui;
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(apiCode + '\n' + pageCode) + '\nglobalThis.Page = TaskDetailPage;', context);
  const page = new context.Page(undefined, { task: structuredClone(task), taskId: 'task-1' });
  return { page, texts, buttons, keys, toasts };
}

test('completed cargo shows pieces and edit action, totals refresh and changed item keys invalidate old cards', () => {
  const f = fixture();
  f.page.initialRender();
  assert.ok(f.texts.includes('件数：2件'));
  assert.ok(f.texts.includes('共2件'));
  assert.ok(f.buttons.includes('编辑'));
  const oldKey = f.keys[0];
  f.page.task = { ...task, items: [{ ...item, pieces: 7 }] };
  f.texts.length = f.keys.length = 0;
  f.page.initialRender();
  assert.ok(f.texts.includes('件数：7件'));
  assert.ok(f.texts.includes('共7件'));
  assert.notEqual(f.keys[0], oldKey);
});

test('editing pre-fills the item, saves via PUT, replaces the task and does not add another item', async () => {
  const f = fixture({ async put(path, body) {
    assert.equal(path, '/api/tasks/task-1/items/item-1');
    assert.equal(body.pieces, 5);
    assert.equal(body.waybillNo, 'WB-2');
    return JSON.stringify({ ...task, items: [{ ...item, pieces: 5, waybillNo: 'WB-2' }] });
  } });
  assert.equal(typeof f.page.openEditItem, 'function');
  f.page.openEditItem(f.page.task.items[0]);
  assert.equal(f.page.itemPieces, '2');
  assert.equal(f.page.itemWaybillNo, 'WB-1');
  f.page.itemPieces = '5'; f.page.itemWaybillNo = ' WB-2 ';
  await f.page.submitAddItem();
  assert.equal(f.page.task.items.length, 1);
  assert.equal(f.page.task.items[0].pieces, 5);
  assert.equal(f.page.showAddItem, false);
});

test('invalid quantity and failed save keep editor and original values intact', async () => {
  let calls = 0;
  const f = fixture({ async put() { calls++; throw new Error('offline'); } });
  assert.equal(typeof f.page.openEditItem, 'function');
  f.page.openEditItem(f.page.task.items[0]);
  for (const value of ['0', '-1', '1.5', '2x', '', '9007199254740992']) {
    f.page.itemPieces = value; await f.page.submitAddItem();
  }
  assert.equal(calls, 0);
  f.page.itemPieces = '3'; await f.page.submitAddItem();
  assert.equal(calls, 1);
  assert.equal(f.page.showAddItem, true);
  assert.equal(f.page.task.items[0].pieces, 2);
  assert.equal(f.page.savingItem, false);
});

test('completing existing cargo never appends the total as a duplicate item', async () => {
  const f = fixture({ async post(path) {
    assert.equal(path, '/api/tasks/task-1/complete');
    return JSON.stringify(task);
  } });
  f.page.task = { ...task, status: 'in_progress' };
  f.page.openComplete();
  await f.page.submitComplete();
  assert.equal(f.page.showComplete, false, f.toasts.join(','));
  assert.equal(f.page.task.items.length, 1);
  assert.equal(f.page.totalPieces(), 2);
});

test('a stale detail request cannot overwrite a saved edit', async () => {
  let finishGet;
  const f = fixture({
    get: () => new Promise(resolve => { finishGet = resolve; }),
    put: async () => JSON.stringify({ ...task, items: [{ ...item, pieces: 6 }] })
  });
  assert.equal(typeof f.page.openEditItem, 'function');
  const pendingLoad = f.page.load();
  f.page.openEditItem(f.page.task.items[0]); f.page.itemPieces = '6';
  await f.page.submitAddItem();
  finishGet(JSON.stringify(task)); await pendingLoad;
  assert.equal(f.page.task.items[0].pieces, 6);
});

test('completion retry after a failed request does not insert cargo twice', async () => {
  let additions = 0, completions = 0;
  const f = fixture({ async post(path, body) {
    if (path.endsWith('/items')) { additions++; assert.equal(body.pieces, 3); return JSON.stringify({ ...task, status: 'in_progress', items: [{ ...item, pieces: 3 }] }); }
    assert.ok(path.endsWith('/complete'));
    if (++completions === 1) throw new Error('retry');
    return JSON.stringify({ ...task, items: [{ ...item, pieces: 3 }] });
  } });
  f.page.task = { ...task, status: 'in_progress', items: [] };
  f.page.openComplete(); f.page.completePieces = '3';
  await f.page.submitComplete(); await f.page.submitComplete();
  assert.equal(additions, 1);
  assert.equal(f.page.totalPieces(), 3);
  assert.equal(f.page.showComplete, false);
});
