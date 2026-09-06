import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const cache = 'entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/';
const read = path => readFileSync(cache + path + '.ts', 'utf8').replace(/^import .*;\r?\n/gm, '');
const code = read('api/TaskApi').replace('export class TaskApi', 'class TaskApi') + read('api/CustomerApi').replace('export class CustomerApi', 'class CustomerApi') + read('pages/DispatchPage');
function fixture(post = async () => JSON.stringify({ id: 'new-task', status: 'pending' }), params = {}, get = async () => '[]') {
  const toasts = [], routes = [], texts = [], buttons = [];
  const noop = () => {};
  const ui = new Proxy({}, { get: () => noop });
  class State { constructor(v) { this.v = v; } get() { return this.v; } set(v) { this.v = v; } }
  class ViewPU {
    static create() {} finalizeConstruction() {}
    observeComponentCreation2(f) { f(0, true); }
    ifElseBranchUpdateFunction(i, f) { f(); }
    forEachUpdateFunction(i, items, f) { items.forEach(f); }
    updateStateVarsOfChildByElmtId() {}
  }
  const context = { ViewPU, ObservedPropertySimplePU: State, ObservedPropertyObjectPU: State,
    registerNamedRoute: noop, MobileHeader: class {}, MobileDrawer: class {},
    SessionStore: { isLoggedIn: () => true, getUser: () => ({ id: 'user1', role: 'worker', courierId: 'worker1', name: '本人' }) },
    normalizeRole: v => v, router: { getParams: () => params, replaceUrl: v => routes.push(v) },
    ApiClient: { post, get }, UiUtil: { toast: v => toasts.push(v) }, setTimeout, clearTimeout,
    EmployeeApi: { workers: async () => { throw new Error('worker must not load staff assignment options'); } },
    AreaApi: { list: async () => { throw new Error('worker must not load assignment options'); } },
    Text: new Proxy({}, { get: (_, k) => k === 'create' ? v => texts.push(v) : noop }),
    Button: new Proxy({}, { get: (_, k) => k === 'createWithLabel' ? v => buttons.push(v) : noop }) };
  for (const name of ['Stack', 'Column', 'Row', 'Blank', 'Scroll', 'If', 'ForEach', 'TextInput', 'FontWeight',
    'HorizontalAlign', 'Alignment', 'TextAlign', 'InputType', 'ScrollDirection']) context[name] = ui;
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(code) + '\nglobalThis.Page = DispatchPage;', context);
  const page = new context.Page(undefined, {});
  page.aboutToAppear();
  return { page, toasts, routes, buttons, texts };
}
const option = { customerId: 'c1', customerName: '杨3', addressId: 'a1', address: '一区地址', contact: '张三', phone: '123456', areaName: '一区' };
test('homepage and drawer entry without router params never crash', () => {
  const f = fixture(undefined, null);
  assert.equal(f.page.isWorker, true);
});
test('selecting a customer address creates an order without inventing pieces or requesting manual fields', async () => {
  let body;
  const f = fixture(async (path, payload) => { assert.equal(path, '/api/tasks'); body = payload; return JSON.stringify({ id: 'new-task' }); });
  f.page.selectWorkerCustomer(option);
  await f.page.submit();
  assert.ok(body, f.toasts.join(','));
  assert.equal(body.customerId, 'c1'); assert.equal(body.addressId, 'a1');
  assert.equal(body.workerId, 'worker1'); assert.equal(body.items.length, 0);
  assert.equal(f.routes[0].params.id, 'new-task');
});
test('worker form only asks for customer and hides staff assignment and cargo quantity', async () => {
  const f = fixture(); await f.page.loadOptions(); f.page.initialRender();
  assert.equal(f.toasts.length, 0, f.toasts.join(','));
  assert.ok(!f.buttons.includes('手动填写')); assert.ok(!f.texts.includes('货物件数（必填）'));
  assert.ok(f.buttons.includes('确认新增')); assert.ok(!f.texts.some(v => String(v).startsWith('推荐：')));
});
test('live input debounces requests, encodes queries and clears old selected customer', async () => {
  const calls = [];
  const f = fixture(undefined, null, async path => { calls.push(path); return JSON.stringify([option]); });
  f.page.selectWorkerCustomer(option);
  f.page.changeWorkerSearch('y'); f.page.changeWorkerSearch('yang3');
  await new Promise(r => setTimeout(r, 350));
  assert.deepEqual(calls, ['/api/worker/customer-options?search=yang3']);
  assert.equal(f.page.selectedWorkerCustomer, null);
  assert.equal(f.page.workerCustomers[0].customerName, '杨3');
  f.page.changeWorkerSearch('');
  assert.equal(f.page.workerCustomers.length, 0);
  f.page.aboutToDisappear();
});
test('unselected text cannot submit and failed submission keeps the selected address', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('offline'); });
  f.page.searchKeyword = '杨3'; await f.page.submit();
  assert.equal(calls, 0);
  f.page.selectWorkerCustomer(option); await f.page.submit();
  assert.equal(calls, 1); assert.equal(f.page.submitting, false);
  assert.equal(f.page.selectedWorkerCustomer.addressId, 'a1'); assert.equal(f.routes.length, 0);
});

test('old or failed search responses cannot replace new results or resurrect a selected list', async () => {
  const pending = [];
  const f = fixture(undefined, null, path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })));
  f.page.changeWorkerSearch('y'); await new Promise(r => setTimeout(r, 280));
  f.page.changeWorkerSearch('y3'); await new Promise(r => setTimeout(r, 280));
  pending[1].resolve(JSON.stringify([option])); await new Promise(r => setTimeout(r, 0));
  pending[0].resolve(JSON.stringify([{ ...option, customerName: '旧结果' }])); await new Promise(r => setTimeout(r, 0));
  assert.equal(f.page.workerCustomers[0].customerName, '杨3');
  f.page.changeWorkerSearch('yang'); await new Promise(r => setTimeout(r, 280));
  f.page.changeWorkerSearch(''); pending[2].reject(new Error('offline')); await new Promise(r => setTimeout(r, 0));
  assert.equal(f.page.workerCustomers.length, 0); assert.equal(f.page.searchingCustomers, false);
  f.page.aboutToDisappear();
});

test('load more retains first-page addresses and makes later same-name addresses selectable', async () => {
  const calls = [];
  const f = fixture(undefined, null, async path => {
    calls.push(path);
    return JSON.stringify(path.includes('offset=50') ? [{ ...option, addressId: 'a-last' }] :
      Array.from({ length: 50 }, (_, i) => ({ ...option, addressId: `a-${i}` })));
  });
  f.page.changeWorkerSearch('杨3'); await new Promise(r => setTimeout(r, 300));
  assert.equal(f.page.workerCustomers.length, 50);
  await f.page.loadMoreWorkerCustomers();
  assert.equal(f.page.workerCustomers.length, 51);
  assert.equal(f.page.hasMoreCustomers, false);
  assert.ok(calls[1].endsWith('&offset=50'));
  f.page.selectWorkerCustomer(f.page.workerCustomers[50]);
  assert.equal(f.page.selectedWorkerCustomer.addressId, 'a-last');
});
