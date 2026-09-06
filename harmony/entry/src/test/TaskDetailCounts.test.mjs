// Run after assembleHap. Executes the actual compiler-generated render callbacks
// with a small ArkUI test double; this is not a device rendering/pixel test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const path = 'entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/pages/TaskDetailPage.ts';
const compiled = readFileSync(path, 'utf8').replace(/^import .*;\r?\n/gm, '');
const labels = ['货物明细', '取件照片', '异常'];

function checkCounts(source) {
  let activeCallback;
  let currentText;
  const headings = new Map();
  const noop = () => {};
  const ui = new Proxy({}, { get: () => noop });
  class State {
    constructor(value) { this.value = value; }
    get() { return this.value; }
    set(value) { this.value = value; }
  }
  class ViewPU {
    static create() {}
    finalizeConstruction() {}
    observeComponentCreation2(callback) {
      const previous = activeCallback;
      activeCallback = callback;
      callback(0, true);
      activeCallback = previous;
    }
    ifElseBranchUpdateFunction(index, render) { render(); }
    forEachUpdateFunction(id, items, render) { items.forEach(render); }
    updateStateVarsOfChildByElmtId() {}
  }
  const context = {
    ViewPU, ObservedPropertyObjectPU: State, ObservedPropertySimplePU: State,
    registerNamedRoute: noop, RefreshIconButton: class {},
    taskStatusLabel: value => value, fmtTime: value => value,
    Text: new Proxy({}, { get: (_, key) => key === 'create' ? value => {
      currentText = value;
      for (const label of labels) if (String(value).startsWith(label + '（')) headings.set(label, activeCallback);
    } : noop })
  };
  for (const name of ['Column', 'Row', 'Button', 'Blank', 'Scroll', 'If', 'ForEach', 'LoadingProgress',
    'FontWeight', 'TextAlign', 'Alignment', 'FlexAlign', 'HorizontalAlign']) context[name] = ui;
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.Page = TaskDetailPage;', context);
  const task = { status: 'in_progress', items: [], photos: [], exceptions: [], workers: [],
    pickupNote: '', internalNote: '', taskType: 'normal' };
  const page = new context.Page(undefined, { task });
  page.initialRender();
  assert.equal(headings.size, 3);
  const callbacks = labels.map(label => headings.get(label));
  // Same Text nodes must reflect response replacements, including upload batches
  // and later deletions; re-entering the page must not be required.
  for (const count of [1, 3, 0]) {
    page.task = { ...task, items: Array(count).fill({}), photos: Array(count).fill({}), exceptions: Array(count).fill({}) };
    callbacks.forEach((callback, index) => {
      callback(0, false);
      assert.equal(currentText, `${labels[index]}（${count}）`);
    });
  }
}

checkCounts(compiled);
// Mutation check: restoring the previous by-value builder must reproduce stale 0.
const oldPattern = compiled.replace(/this\.observeComponentCreation2\(\(elmtId, isInitialRender\) => \{\s*Text\.create\(('(?:货物明细|取件照片|异常)（' \+ this\.task\.(?:items|photos|exceptions)\.length \+ '）')\);[\s\S]*?\}, Text\);/g,
  'this.SectionTitle($1);');
assert.notEqual(oldPattern, compiled);
assert.throws(() => checkCounts(oldPattern), /0.*1|1.*0/s);
console.log('Task detail compiled-render count regression: PASS (1, 3, 0; old builder fails)');
