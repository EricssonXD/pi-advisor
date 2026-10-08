import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load the actual extension factory/registered execute, without a host or paid SDK call.
const host = `export const getAgentDir = () => globalThis.__advisorTestAgentDir;
export const keyHint = () => '';`;
const tui = `export class Container { addChild() {} clear() {} render() { return []; } invalidate() {} }
export class Spacer {} export class Text {} export class Input { getValue() { return this.value ?? ''; } setValue(value) { this.value = value; } handleInput() {} }
export class SelectList { constructor(items) { this.items = items; globalThis.__advisorTestModelList = this; } setSelectedIndex(index) { this.selectedIndex = index; } handleInput() {} }
export const fuzzyFilter = (items) => items;`;
const typebox = `export const Type = new Proxy({}, { get: () => () => ({}) });`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  const source = specifier === '@earendil-works/pi-coding-agent' ? host
    : specifier === '@earendil-works/pi-tui' ? tui : specifier === 'typebox' ? typebox : undefined;
  return source === undefined ? next(specifier, context)
    : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
} });
const { default: advisorExtension } = await import('../index.ts');
hooks.deregister();

const trackerRoot = process.env.PI_USAGE_TEST_ROOT;
const realTracker = trackerRoot ? await import(pathToFileURL(join(resolve(trackerRoot), 'collector.ts')).href) : undefined;
const ownerKeys = ['sessionId', 'rootSessionId', 'workflowId', 'source', 'toolCallId', 'rootToolCallId', 'parentToolCallId'];
const usageKeys = ['id', 'attemptId', 'eventTime', 'provider', 'api', 'model', 'representation', 'tokens', 'price', 'callCount', 'durationMs', 'outcome'];
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cacheWrite1h', 'providerTotal'];
const response = (patch = {}) => ({
  provider: 'physical-provider', api: 'physical-api', model: 'requested-alias', responseModel: 'physical-model',
  stopReason: 'stop', content: [{ type: 'text', text: 'On track: keep the useful advice.' }],
  usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, totalTokens: 38, cost: { total: 0.12 } }, ...patch,
});
function bus() {
  const listeners = new Map();
  return {
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    emit(name, data) { listeners.get(name)?.(data); },
  };
}
function structuralTracker(events) {
  let workflowId = 'A';
  const attempts = new Map(), records = new Map();
  const context = options => Object.freeze({ version: 1, generation: 'generation', ledgerId: 'ledger', sessionId: 'parent', rootSessionId: 'parent', workflowId, source: 'main', toolCallId: null, rootToolCallId: null, parentToolCallId: null, ...options });
  const begin = input => {
    assert.deepEqual(Object.keys(input).sort(), ['context', 'id', 'startedAt']);
    const old = attempts.get(input.id);
    if (old) assert.deepEqual(old.context, input.context);
    else attempts.set(input.id, structuredClone({ ...input, completion: null }));
    return { ok: true, value: old ? 'duplicate' : 'inserted' };
  };
  const finish = input => {
    const a = attempts.get(input.completion.id);
    assert.ok(a, 'finish must link a begun attempt');
    assert.deepEqual(a.context, input.context);
    if (input.usage) {
      assert.deepEqual(Object.keys(input.usage).sort(), usageKeys.toSorted());
      assert.ok(Object.keys(input.usage.tokens).every(k => tokenKeys.includes(k)), 'no derived total/complete fields');
      assert.equal(input.usage.attemptId, input.completion.id);
      assert.equal(input.usage.id, input.completion.usageId);
      assert.equal(input.completion.outcome, undefined);
      assert.ok(!ownerKeys.some(k => k in input.usage));
      const old = records.get(input.usage.id);
      if (old) assert.deepEqual(old, input.usage);
      else records.set(input.usage.id, structuredClone(input.usage));
    } else {
      assert.equal(input.completion.usageId, undefined);
      assert.ok(['no-usage', 'error', 'interrupted'].includes(input.completion.outcome));
    }
    if (a.completion) assert.deepEqual(a.completion, input.completion);
    a.completion = structuredClone(input.completion);
    return { ok: true, value: 'complete' };
  };
  const service = { version: 1, generation: 'generation', capabilities: { context: true, reporting: true },
    captureContext(options) { return { ok: true, value: context(options) }; },
    async beginAttempt(input) { return begin(input); }, async finishAttempt(input) { return finish(input); },
  };
  events.on('pi-usage:v1:discover', request => request.reply({ ok: true, value: service }));
  return { service, attempts, records, consumeB() { workflowId = 'B'; }, replay(entries) {
    for (const e of entries.filter(e => e.customType === 'pi-usage.record')) {
      assert.equal(e.data.version, 1);
      begin({ context: e.data.context, ...e.data.attempt }); finish(e.data);
    }
  } };
}
async function fixture({ tracked = true, real = false, branch, noModel = false, appendFailure, uiFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-tracker-'));
  globalThis.__advisorTestAgentDir = dir;
  const entries = [], events = bus(), tools = new Map(), handlers = new Map(), commands = new Map(), notifications = [];
  let activeToolUpdates = 0, customCalls = 0;
  const appendEntry = (customType, data) => {
    if (appendFailure?.(customType)) throw new Error('telemetry write failed');
    entries.push({ id: `entry-${entries.length}`, type: 'custom', customType, data: structuredClone(data), timestamp: new Date().toISOString() });
  };
  const pi = { events, appendEntry, on(name, callback) { handlers.set(name, callback); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return ['advisor']; }, getAllTools() { return []; }, setActiveTools() { activeToolUpdates++; },
  };
  const manager = { getSessionId: () => 'parent', getSessionFile: () => undefined,
    getEntries: () => entries, getEntryCount: () => entries.length,
    getBranch: () => branch ?? [{ type: 'message', message: { role: 'user', content: 'SECRET user task', timestamp: 1 } }],
  };
  let collector, tracker;
  if (real) {
    collector = await realTracker.UsageCollector.start({ agentDir: dir, manager, events, appendEntry });
    const a = await collector.runtime.consumeUser({ kind: 'ordinary', startedAt: 1 });
    assert.equal(a.ok, true);
    tracker = { service: collector.runtime.service, workflowA: a.value.workflow.id,
      async consumeB() { const b = await collector.runtime.consumeUser({ kind: 'ordinary', startedAt: 2 }); assert.equal(b.ok, true); return b.value.workflow.id; },
      replay: () => collector.collect(), snapshot: () => collector.store.snapshot(),
    };
  } else if (tracked) tracker = structuralTracker(events);
  let complete = async () => response();
  let calls = 0;
  const ctx = { sessionManager: manager, getSystemPrompt: () => 'SECRET system prompt', mode: 'tui', scopedModels: [],
    model: { provider: 'executor-provider', id: 'executor-model' },
    modelRegistry: { find: () => noModel ? undefined : ({ provider: 'configured-provider', id: 'configured-model', api: 'configured-api', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      getAvailable: () => noModel ? [] : [{ provider: 'configured-provider', id: 'configured-model', name: 'Configured model' }],
      async complete(...args) { calls++; return complete(...args); } },
    ui: { setStatus() { if (uiFailure) throw new Error('UI metrics unavailable'); },
      notify(...message) { notifications.push(message); },
      custom(factory) { customCalls++; return new Promise(resolve => factory({ requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, { matches: () => false }, resolve)); },
    },
  };
  advisorExtension(pi);
  return { entries, events, tracker, ctx, tools, commands, notifications, get customCalls() { return customCalls; }, get activeToolUpdates() { return activeToolUpdates; }, get calls() { return calls; },
    setComplete(fn) { complete = fn; }, execute: (id = 'tool-A') => tools.get('advisor').execute(id, {}, undefined, undefined, ctx),
    async close() { if (collector) await collector.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const canonical = f => f.entries.filter(e => e.customType === 'pi-usage.record');

test('advisor model picker persists selection without changing executor model; cancellation is a no-op', async () => {
  const f = await fixture({ tracked: false });
  try {
    const handler = f.commands.get('advisor').handler;
    const selectModel = handler('model', f.ctx);
    globalThis.__advisorTestModelList.onSelect(globalThis.__advisorTestModelList.items[0]);
    await selectModel;
    const configPath = join(globalThis.__advisorTestAgentDir, 'advisor.json');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual([saved.provider, saved.model, saved.enabled], ['configured-provider', 'configured-model', false]);
    assert.deepEqual(f.ctx.model, { provider: 'executor-provider', id: 'executor-model' });
    const notifications = f.notifications.length;
    const activeToolUpdates = f.activeToolUpdates;

    const changeModel = handler('model', f.ctx);
    globalThis.__advisorTestModelList.onCancel();
    await changeModel;
    const enable = handler('on', f.ctx);
    globalThis.__advisorTestModelList.onCancel();
    await enable;
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), saved);
    assert.equal(f.notifications.length, notifications);
    assert.equal(f.activeToolUpdates, activeToolUpdates);
    assert.deepEqual(f.ctx.model, { provider: 'executor-provider', id: 'executor-model' });
  } finally { await f.close(); }
});

test('advisor model picker reports when no configured-provider models are available', async () => {
  const f = await fixture({ tracked: false, noModel: true });
  try {
    await f.commands.get('advisor').handler('model', f.ctx);
    assert.equal(f.notifications.at(-1)[0], 'No models available for configured providers. Use /login to add providers.');
    assert.equal(f.customCalls, 0);
  } finally { await f.close(); }
});

// These portable contract tests always run; only the real cross-package cases require an override.
test('tracker absent: registered execute retains legacy usage/details and never backfills', async () => {
  const f = await fixture({ tracked: false });
  try {
    const result = await f.execute();
    assert.match(result.content[0].text, /useful advice/);
    assert.equal(result.details.usage.inputTokens, 10);
    assert.equal(f.entries[0].customType, 'advisor-usage');
    assert.equal(canonical(f).length, 0);
    structuralTracker(f.events).replay(f.entries);
    assert.equal(canonical(f).length, 0);
  } finally { await f.close(); }
});

test('canonical/API IDs match; native base tokens, physical model, and one replay charge', async () => {
  const f = await fixture();
  try {
    await f.execute();
    const marker = canonical(f)[0].data;
    assert.deepEqual(Object.keys(marker).sort(), ['attempt', 'completion', 'context', 'usage', 'version']);
    assert.equal(marker.context.source, 'pi-advisor');
    assert.equal(marker.context.toolCallId, 'tool-A');
    assert.equal(marker.context.rootToolCallId, 'tool-A');
    assert.equal(marker.usage.provider, 'physical-provider');
    assert.equal(marker.usage.api, 'physical-api');
    assert.equal(marker.usage.model, 'physical-model');
    assert.deepEqual(marker.usage.tokens, { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: null, cacheWrite1h: null, providerTotal: 38 });
    assert.equal(marker.usage.price.evidence, 'catalog-estimate');
    assert.doesNotMatch(JSON.stringify(marker), /SECRET|useful advice|configured-provider/);
    f.tracker.replay(f.entries); f.tracker.replay(f.entries);
    assert.equal(f.tracker.records.size, 1);
    assert.equal(f.tracker.attempts.get(marker.attempt.id).completion.usageId, marker.usage.id);
    await f.execute('tool-A');
    assert.notEqual(canonical(f)[1].data.attempt.id, marker.attempt.id, 'each dispatch is a distinct stable attempt');
  } finally { await f.close(); }
});

test('begin is awaited before SDK dispatch; A ownership survives consumed B', async () => {
  const f = await fixture();
  try {
    const original = f.tracker.service.beginAttempt;
    let release, begun;
    const started = new Promise(r => { begun = r; });
    f.tracker.service.beginAttempt = async input => { begun(input); await new Promise(r => { release = r; }); return original(input); };
    f.setComplete(async () => { f.tracker.consumeB(); return response(); });
    const running = f.execute();
    const attempt = await started;
    assert.equal(f.calls, 0);
    assert.equal(attempt.context.workflowId, 'A');
    f.tracker.consumeB(); release();
    await running;
    assert.equal(canonical(f)[0].data.context.workflowId, 'A');
    f.tracker.service.beginAttempt = original;
    await f.execute('tool-B');
    assert.equal(canonical(f)[1].data.context.workflowId, 'B');
  } finally { await f.close(); }
});

test('discovery is synchronous, re-resolved each execute, and failed capture emits no marker', async () => {
  const f = await fixture({ tracked: false });
  try {
    let discoveries = 0;
    f.events.on('pi-usage:v1:discover', req => { discoveries++; queueMicrotask(() => req.reply({ ok: true, value: { version: 1 } })); });
    await f.execute();
    const tracker = structuralTracker(f.events);
    tracker.service.captureContext = () => ({ ok: false, code: 'unavailable' });
    await f.execute();
    assert.equal(discoveries, 1);
    assert.equal(canonical(f).length, 0);
    assert.equal(tracker.attempts.size, 0);
  } finally { await f.close(); }
});

test('transport failure and successful response without usage finish unknown coverage, not zero charges', async () => {
  for (const [reply, outcome, error] of [
    [async () => { throw new Error('transport failed'); }, 'error', 'execution_failed'],
    [async () => response({ usage: undefined }), 'no-usage', undefined],
    [async () => response({ usage: undefined, stopReason: 'aborted', errorMessage: 'cancelled' }), 'interrupted', 'model_error'],
  ]) {
    const f = await fixture();
    try {
      f.setComplete(reply);
      const result = await f.execute();
      assert.equal(result.details.error, error);
      assert.equal(f.tracker.attempts.values().next().value.completion.outcome, outcome);
      assert.equal(f.tracker.records.size, 0);
      assert.equal(canonical(f).length, 0);
    } finally { await f.close(); }
  }
});

test('preconditions never create tracker attempts or SDK calls', async () => {
  for (const [options, error] of [[{ noModel: true }, 'model_not_found'], [{ branch: [] }, 'no_context']]) {
    const f = await fixture(options);
    try {
      assert.equal((await f.execute()).details.error, error);
      assert.equal(f.calls, 0); assert.equal(f.tracker.attempts.size, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    for (let n = 0; n < 3; n++) await f.execute();
    assert.equal((await f.execute()).details.error, 'max_uses_exceeded');
    assert.equal(f.calls, 3); assert.equal(f.tracker.attempts.size, 3);
  } finally { await f.close(); }
});

test('empty/error physical responses count actual usage; zero catalog and missing tokens stay unknown', async () => {
  for (const patch of [{ content: [] }, { stopReason: 'error', errorMessage: 'provider failed' }, { stopReason: 'aborted', errorMessage: 'aborted' }]) {
    const f = await fixture();
    try {
      f.setComplete(async () => response({ ...patch, responseModel: undefined, usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0 } } }));
      const result = await f.execute();
      assert.ok(result.details.error);
      const u = canonical(f)[0].data.usage;
      assert.equal(u.model, 'requested-alias');
      assert.equal(u.tokens.cacheRead, null); assert.equal(u.tokens.cacheWrite, null);
      assert.deepEqual(u.price, { amount: null, evidence: 'unknown' });
      assert.equal(u.outcome, patch.stopReason === 'aborted' ? 'aborted' : patch.stopReason === 'error' ? 'error' : 'success');
      assert.equal(f.tracker.records.size, 1);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    f.setComplete(async () => response({ stopReason: 'error', errorMessage: 'SDK placeholder', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } }));
    await f.execute();
    assert.deepEqual(canonical(f)[0].data.usage.tokens, {});
    assert.deepEqual(canonical(f)[0].data.usage.price, { amount: null, evidence: 'unknown' });
  } finally { await f.close(); }
});

test('begin/storage/legacy/UI telemetry failures preserve advice and recover from canonical evidence', async () => {
  for (const failure of ['begin-result', 'begin-throw', 'finish-result', 'finish-throw']) {
    const f = await fixture({ uiFailure: true, appendFailure: type => type === 'advisor-usage' });
    try {
      if (failure.startsWith('begin')) f.tracker.service.beginAttempt = async () => {
        if (failure.endsWith('throw')) throw new Error('storage');
        return { ok: false, code: 'storage' };
      };
      f.tracker.service.finishAttempt = async () => {
        if (failure.endsWith('throw')) throw new Error('storage');
        return { ok: false, code: 'storage' };
      };
      const result = await f.execute();
      assert.match(result.content[0].text, /useful advice/);
      assert.equal(result.details.error, undefined); assert.equal(result.details.usage.inputTokens, 10);
      assert.ok(canonical(f)[0].data.attempt);
      f.tracker.replay(f.entries); f.tracker.replay(f.entries);
      assert.equal(f.tracker.records.size, 1);
    } finally { await f.close(); }
  }
  const f = await fixture({ appendFailure: type => type === 'pi-usage.record' });
  try {
    assert.match((await f.execute()).content[0].text, /useful advice/);
    assert.equal(canonical(f).length, 0); assert.equal(f.tracker.records.size, 1, 'API reporting survives marker failure');
  } finally { await f.close(); }
});

for (const failure of [undefined, 'begin', 'finish']) test(`real tracker: API/replay idempotency and A/B ownership${failure ? ` after ${failure}/storage failure` : ''}`, { skip: !trackerRoot && 'set PI_USAGE_TEST_ROOT to run real cross-package integration' }, async () => {
  const f = await fixture({ real: true });
  try {
    if (failure) {
      const service = { ...f.tracker.service,
        ...(failure === 'begin' ? { async beginAttempt() { return { ok: false, code: 'storage' }; } } : {}),
        async finishAttempt() { return { ok: false, code: 'storage' }; },
      };
      f.events.on('pi-usage:v1:discover', request => request.reply({ ok: true, value: service }));
    }
    let workflowB;
    f.setComplete(async () => { workflowB = await f.tracker.consumeB(); return response(); });
    const result = await f.execute();
    assert.match(result.content[0].text, /useful advice/);
    const marker = canonical(f)[0].data;
    assert.equal(marker.context.workflowId, f.tracker.workflowA);
    assert.notEqual(marker.context.workflowId, workflowB);
    await f.tracker.replay(f.entries); await f.tracker.replay(f.entries);
    const s = await f.tracker.snapshot();
    assert.equal(s.usage.length, 1);
    assert.equal(s.usage[0].id, marker.usage.id);
    assert.equal(s.usage[0].tokens.total, 38);
    assert.equal(s.usage[0].workflowId, f.tracker.workflowA);
    const attempt = s.attempts.find(a => a.id === marker.attempt.id);
    assert.equal(attempt.usageId, marker.usage.id);
    assert.equal(attempt.state, 'complete');
    const ack = await f.tracker.service.finishAttempt({ context: marker.context, usage: marker.usage, completion: marker.completion });
    assert.equal(ack.ok, true);
    assert.equal((await f.tracker.snapshot()).usage.length, 1);
  } finally { await f.close(); }
});

test('runtime does not import tracker installations or change legacy usage markers', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+["'][^"']*pi-usage|import\([^)]*pi-usage|PI_USAGE_TEST_ROOT/);
  assert.match(source, /pi\.appendEntry\("advisor-usage", usage\)/);
});
