import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAdvisorUsage, recordAdvisorUsage } from '../src/advisor-usage.ts';

test('recordAdvisorUsage preserves returned token counts and known SDK cost', () => {
  const usage = { input: 120, output: 20, cacheRead: 4, cacheWrite: 2, cost: { total: 0.005 } };
  const pricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 };
  assert.deepEqual(recordAdvisorUsage(usage, 'anthropic', 'claude-test', pricing), {
    inputTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    provider: 'anthropic',
    model: 'claude-test',
    costUsd: 0.005,
  });
  assert.equal(recordAdvisorUsage(undefined, 'anthropic', 'claude-test', pricing), undefined);
  assert.equal(recordAdvisorUsage({ ...usage, cost: { total: 0 } }, 'local', 'free-model', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).costUsd, undefined);
});

test('aggregateAdvisorUsage totals advisor calls and skips unpriced or malformed data', () => {
  const totals = aggregateAdvisorUsage([
    { type: 'custom', customType: 'advisor-usage', data: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 2, costUsd: 0.005 } },
    { type: 'custom', customType: 'advisor-usage', data: { inputTokens: 80, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 } },
    { type: 'custom', customType: 'advisor-usage', data: { inputTokens: 15, outputTokens: 5, model: 'old-record' } },
    { type: 'custom', customType: 'other', data: { inputTokens: 100, outputTokens: 100, costUsd: 1 } },
    { type: 'custom', customType: 'advisor-usage', data: { inputTokens: -1, outputTokens: 5 } },
  ]);

  assert.deepEqual(totals, {
    calls: 3,
    inputTokens: 215,
    outputTokens: 55,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    cacheUnknownCalls: 1,
    costUsd: 0.007,
    pricedCalls: 2,
  });
});
