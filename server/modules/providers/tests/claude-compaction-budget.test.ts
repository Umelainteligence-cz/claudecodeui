import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { abortClaudeSDKSession } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getClaudePostCompactReading,
  rememberClaudeContextWindow,
} from '@/modules/providers/services/provider-token-usage.service.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { runScripted } from '@/modules/providers/tests/scripted-claude-sdk.js';

/**
 * After a main-thread compact_boundary the runtime asks the live CLI for its
 * own context measurement (`getContextUsage()`) and sends that, or an explicit
 * clear (`tokenBudget: null`), before the compaction turn completes. The three
 * cases the coordinator pinned - success, failure -> null, zero result
 * ignored - are separate tests below. Streams are shaped on the frames the
 * SDK 0.3.165 probe recorded.
 */

type Budget = {
  used: number;
  total: number;
  contextWindowSource?: string;
  autoCompactLimit?: number;
  inputTokens: number;
  outputTokens: number;
};

const budgetFrames = (sent: NormalizedMessage[]) =>
  sent.filter((message) => message.kind === 'status' && message.text === 'token_budget');

const tokenBudgets = (sent: NormalizedMessage[]) =>
  budgetFrames(sent).map((message) => message.tokenBudget as Budget | null);

const indexOfComplete = (sent: NormalizedMessage[]) => sent.findIndex((message) => message.kind === 'complete');

const zeroUsage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };

const init = (nativeId: string) => ({ type: 'system', subtype: 'init', session_id: nativeId });

const compacting = (nativeId: string) => ({ type: 'system', subtype: 'status', status: 'compacting', session_id: nativeId });

const boundary = (nativeId: string, uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: nativeId,
  uuid,
  compact_metadata: { trigger: 'manual', pre_tokens: 79_626, post_tokens: 1_722, duration_ms: 10_610 },
  ...extra,
});

const summary = (nativeId: string) => ({
  type: 'user',
  session_id: nativeId,
  parent_tool_use_id: null,
  isSynthetic: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
});

const assistant = (nativeId: string, usage: Record<string, number>) => ({
  type: 'assistant',
  session_id: nativeId,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage },
});

const result = (nativeId: string, numTurns: number, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: nativeId,
  result: '',
  duration_ms: 1,
  num_turns: numTurns,
  usage: zeroUsage,
  ...extra,
});

/** A manual `/compact` turn: no assistant message, a zero-usage result. */
const manualCompactTurn = (nativeId: string, uuid: string) => [
  init(nativeId),
  compacting(nativeId),
  boundary(nativeId, uuid),
  summary(nativeId),
  result(nativeId, 0),
];

const contextUsage = (fields: Record<string, unknown> = {}) => ({
  categories: [],
  totalTokens: 41_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autoCompactThreshold: 967_000,
  isAutoCompactEnabled: true,
  ...fields,
});

/**
 * Runs `body` with setTimeout/clearTimeout spied for timers of one delay, and
 * reports whether each such timer was unref'd and handed to clearTimeout.
 */
async function withTimerSpy(delay: number, body: () => Promise<void>) {
  const created: ReturnType<typeof setTimeout>[] = [];
  const cleared = new Set<unknown>();
  const unrefAtClear = new Map<unknown, boolean>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, timerDelay?: number) => {
    const handle = realSetTimeout(handler, timerDelay);
    if (timerDelay === delay) created.push(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && created.includes(handle)) {
      cleared.add(handle);
      unrefAtClear.set(handle, !handle.hasRef());
    }
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    await body();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { created, cleared, unrefAtClear };
}

test('success: the SDK reading is sent as one token_budget before complete', async () => {
  const sent = await runScripted('app-pc-success', manualCompactTurn('native-pc-success', 'uuid-pc-success'), {
    getContextUsage: async () => contextUsage(),
  });

  const budgets = tokenBudgets(sent);
  assert.equal(budgets.length, 1);
  assert.deepEqual(
    { used: budgets[0]!.used, total: budgets[0]!.total, autoCompactLimit: budgets[0]!.autoCompactLimit, source: budgets[0]!.contextWindowSource },
    { used: 41_000, total: 1_000_000, autoCompactLimit: 967_000, source: 'sdk' },
  );
  assert.equal(budgets[0]!.inputTokens, 41_000);
  assert.equal(budgets[0]!.outputTokens, 0);
  assert.ok(sent.indexOf(budgetFrames(sent)[0]!) < indexOfComplete(sent), 'budget must arrive before complete');
});

test('zero result ignored: the compaction turn\'s zero result adds no budget after the reading', async () => {
  const sent = await runScripted('app-pc-zero', manualCompactTurn('native-pc-zero', 'uuid-pc-zero'), {
    getContextUsage: async () => contextUsage(),
  });

  const resultIndex = sent.findIndex((message) => message.kind === 'complete');
  const framesAfterReading = sent.slice(sent.indexOf(budgetFrames(sent)[0]!) + 1, resultIndex);
  assert.deepEqual(framesAfterReading.filter((message) => message.text === 'token_budget'), []);
  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used), [41_000]);
});

test('failure -> null: a rejecting call sends an explicit clear before complete and stores null', async () => {
  const sent = await runScripted('app-pc-fail', manualCompactTurn('native-pc-fail', 'uuid-pc-fail'), {
    getContextUsage: async () => { throw new Error('control request failed'); },
  });

  const frames = budgetFrames(sent);
  assert.equal(frames.length, 1);
  assert.ok('tokenBudget' in frames[0]!);
  assert.equal(frames[0]!.tokenBudget, null);
  assert.ok(sent.indexOf(frames[0]!) < indexOfComplete(sent));
  assert.equal(getClaudePostCompactReading('uuid-pc-fail'), null);
});

test('a call that never answers is cleared at the timeout and the turn still completes', async () => {
  const started = Date.now();
  let sent: NormalizedMessage[] = [];
  const timers = await withTimerSpy(20, async () => {
    sent = await runScripted('app-pc-hang', manualCompactTurn('native-pc-hang', 'uuid-pc-hang'), {
      getContextUsage: () => new Promise(() => {}),
      contextUsageTimeoutMs: 20,
    });
  });

  assert.ok(Date.now() - started < 2_000, 'the 20 ms timeout must end the wait');
  assert.deepEqual(tokenBudgets(sent), [null]);
  assert.ok(indexOfComplete(sent) > sent.indexOf(budgetFrames(sent)[0]!));
  assert.equal(timers.created.length, 1);
  assert.ok(timers.cleared.has(timers.created[0]), 'no timer may be left pending');
});

test('the timeout timer is unref\'d and cleared once the call answers', async () => {
  const marker = 4_321;
  const { created, cleared, unrefAtClear } = await withTimerSpy(marker, async () => {
    await runScripted('app-pc-timer', manualCompactTurn('native-pc-timer', 'uuid-pc-timer'), {
      getContextUsage: async () => contextUsage(),
      contextUsageTimeoutMs: marker,
    });
  });

  assert.equal(created.length, 1);
  assert.ok(cleared.has(created[0]), 'timer must be cleared');
  assert.equal(unrefAtClear.get(created[0]), true, 'timer must be unref\'d');
});

test('a rejection after the timeout fired is swallowed and sends no second frame', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const sent = await runScripted('app-pc-late', manualCompactTurn('native-pc-late', 'uuid-pc-late'), {
      getContextUsage: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('late')), 60);
      }),
      contextUsageTimeoutMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(tokenBudgets(sent), [null]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('an abort while the call is pending sends no frame and stores nothing', async () => {
  const sent = await runScripted('app-pc-abort', manualCompactTurn('native-pc-abort', 'uuid-pc-abort'), {
    getContextUsage: async () => {
      await abortClaudeSDKSession('app-pc-abort');
      return contextUsage();
    },
  });

  assert.deepEqual(tokenBudgets(sent), []);
  assert.equal(getClaudePostCompactReading('uuid-pc-abort'), undefined);
});

test('a superseding run while the call is pending sends no frame and stores nothing', async () => {
  const sent = await runScripted('app-pc-supersede', manualCompactTurn('native-pc-supersede', 'uuid-pc-supersede'), {
    getContextUsage: async () => {
      // A newer run takes over the same app session while the read is pending.
      await runScripted('app-pc-supersede', [init('native-pc-supersede'), result('native-pc-supersede', 1)]);
      return contextUsage();
    },
  });

  assert.deepEqual(tokenBudgets(sent), []);
  assert.equal(getClaudePostCompactReading('uuid-pc-supersede'), undefined);
});

test('isAutoCompactEnabled false omits autoCompactLimit', async () => {
  const sent = await runScripted('app-pc-noauto', manualCompactTurn('native-pc-noauto', 'uuid-pc-noauto'), {
    getContextUsage: async () => contextUsage({ isAutoCompactEnabled: false }),
  });

  const [budget] = tokenBudgets(sent);
  assert.equal(budget!.used, 41_000);
  assert.equal('autoCompactLimit' in budget!, false);
});

test('at a boundary totalTokens is 0, so used is the category sum without free space and the autocompact buffer', async () => {
  // Probe run A's actual response at the manual boundary.
  const sent = await runScripted('app-pc-categories', manualCompactTurn('native-pc-categories', 'uuid-pc-categories'), {
    getContextUsage: async () => contextUsage({
      totalTokens: 0,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      categories: [
        { name: 'System prompt', tokens: 747 },
        { name: 'MCP tools', tokens: 77_190 },
        { name: 'Memory files', tokens: 45 },
        { name: 'Messages', tokens: 1_786 },
        { name: 'Autocompact buffer', tokens: 33_000 },
        { name: 'Free space', tokens: 120_232 },
      ],
    }),
  });

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget && { used: budget.used, total: budget.total }), [
    { used: 79_768, total: 200_000 },
  ]);
});

test('a reading with no positive total and no categories counts as a failure and clears', async () => {
  const sent = await runScripted('app-pc-empty', manualCompactTurn('native-pc-empty', 'uuid-pc-empty'), {
    getContextUsage: async () => contextUsage({ totalTokens: 0, categories: [{ name: 'Free space', tokens: 200_000 }] }),
  });

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('totalTokens 0 with no categories clears', async () => {
  const sent = await runScripted('app-pc-nocat', manualCompactTurn('native-pc-nocat', 'uuid-pc-nocat'), {
    getContextUsage: async () => {
      const { categories: _omitted, ...rest } = contextUsage({ totalTokens: 0 });
      return rest;
    },
  });

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('totalTokens 0 with categories that are not an array clears', async () => {
  const sent = await runScripted('app-pc-badcat', manualCompactTurn('native-pc-badcat', 'uuid-pc-badcat'), {
    getContextUsage: async () => contextUsage({ totalTokens: 0, categories: { Messages: 1_786 } }),
  });

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('totalTokens 0 with no recognised room-left category clears instead of counting free room', async () => {
  const sent = await runScripted('app-pc-unknowncat', manualCompactTurn('native-pc-unknowncat', 'uuid-pc-unknowncat'), {
    getContextUsage: async () => contextUsage({
      totalTokens: 0,
      categories: [{ name: 'free', tokens: 120_000 }, { name: 'Messages', tokens: 1_786 }],
    }),
  });

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('a reading at or above its window clears', async () => {
  const sent = await runScripted('app-pc-over', manualCompactTurn('native-pc-over', 'uuid-pc-over'), {
    getContextUsage: async () => contextUsage({ totalTokens: 250_000, maxTokens: 200_000 }),
  });

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('a remembered 1M window is corrected to the 200k the compaction turn\'s result reports', async () => {
  const nativeId = 'native-pc-switch';
  rememberClaudeContextWindow(nativeId, 1_000_000);
  const sent = await runScripted('app-pc-switch', [
    init(nativeId),
    compacting(nativeId),
    boundary(nativeId, 'uuid-pc-switch'),
    summary(nativeId),
    result(nativeId, 0, {
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 6_027, outputTokens: 1_333, contextWindow: 200_000 } },
    }),
  ], {
    resumeProviderSessionId: nativeId,
    getContextUsage: async () => contextUsage(),
  });

  const budgets = tokenBudgets(sent);
  assert.equal(budgets[0]!.total, 1_000_000, 'the reading is first measured against the remembered window');
  assert.deepEqual(
    { used: budgets.at(-1)!.used, total: budgets.at(-1)!.total, source: budgets.at(-1)!.contextWindowSource },
    { used: 41_000, total: 200_000, source: 'sdk' },
  );
  const stored = getClaudePostCompactReading('uuid-pc-switch');
  assert.deepEqual(
    { used: stored?.used, total: stored?.total, source: stored?.contextWindowSource },
    { used: 41_000, total: 200_000, source: 'sdk' },
    'history must read the corrected total back',
  );
});

test('auto-compact mid-turn: the post-compact assistant reading is last, in stream order', async () => {
  const nativeId = 'native-pc-auto';
  const preUsage = { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, output_tokens: 90 };
  const postUsage = { input_tokens: 10, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 500, output_tokens: 40 };
  const sent = await runScripted('app-pc-auto', [
    init(nativeId),
    assistant(nativeId, preUsage),
    compacting(nativeId),
    boundary(nativeId, 'uuid-pc-auto', { compact_metadata: { trigger: 'auto', pre_tokens: 150_100, post_tokens: 2_690, duration_ms: 900 } }),
    summary(nativeId),
    assistant(nativeId, postUsage),
    result(nativeId, 2),
  ], {
    getContextUsage: async () => contextUsage({ totalTokens: 3_066 }),
  });

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used), [150_100, 3_066, 3_550]);
});

test('the result-time window re-send does not revive the pre-compact used after a clear', async () => {
  const nativeId = 'native-pc-revive';
  const preUsage = { input_tokens: 10, cache_read_input_tokens: 950_000, cache_creation_input_tokens: 0, output_tokens: 90 };
  const sent = await runScripted('app-pc-revive', [
    init(nativeId),
    assistant(nativeId, preUsage),
    boundary(nativeId, 'uuid-pc-revive'),
    summary(nativeId),
    result(nativeId, 2, {
      modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, contextWindow: 1_000_000 } },
    }),
  ], {
    getContextUsage: async () => { throw new Error('unavailable'); },
  });

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used ?? null), [950_100, null]);
});

test('a boundary carrying parent_tool_use_id triggers no call and no frame', async () => {
  let calls = 0;
  const nativeId = 'native-pc-sidechain';
  const sent = await runScripted('app-pc-sidechain', [
    init(nativeId),
    boundary(nativeId, 'uuid-pc-sidechain', { parent_tool_use_id: 'toolu_1' }),
    result(nativeId, 0),
  ], {
    getContextUsage: async () => { calls += 1; return contextUsage(); },
  });

  assert.equal(calls, 0);
  assert.deepEqual(tokenBudgets(sent), []);
});

test('the reading is remembered under the boundary uuid and the history page cache is invalidated', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-compaction-budget-cache-'));
  const transcriptPath = path.join(tempDirectory, 'native-pc-cache.jsonl');
  try {
    await writeFile(transcriptPath, '{"type":"user"}\n');
    let loads = 0;
    const loadFull = async () => {
      loads += 1;
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    };
    await sessionHistoryCache.getFullHistory({ sessionId: 'app-pc-cache', transcriptPath, loadFull });
    await sessionHistoryCache.getFullHistory({ sessionId: 'app-pc-cache', transcriptPath, loadFull });
    assert.equal(loads, 1);

    await runScripted('app-pc-cache', manualCompactTurn('native-pc-cache', 'uuid-pc-cache'), {
      getContextUsage: async () => contextUsage(),
    });

    assert.equal(getClaudePostCompactReading('uuid-pc-cache')?.used, 41_000);
    await sessionHistoryCache.getFullHistory({ sessionId: 'app-pc-cache', transcriptPath, loadFull });
    assert.equal(loads, 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
