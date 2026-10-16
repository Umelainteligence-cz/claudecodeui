import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';
import { runScripted } from '@/modules/providers/tests/scripted-claude-sdk.js';

/**
 * `used` is the context the session holds right now. These loop-level cases pin
 * what may and may not publish it: a complete main-thread assistant usage
 * always, a single-request `result` as a last resort, and nothing else -
 * never a zero or partial frame, never a multi-request or compaction bill.
 */

const tokenBudgets = (sent: NormalizedMessage[]) =>
  sent
    .filter((message) => message.kind === 'status' && message.text === 'token_budget')
    .map((message) => message.tokenBudget as { used: number; total: number; contextWindowSource?: string } | null);

const fullUsage = { input_tokens: 12, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 500 };
const zeroUsage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };

const assistant = (nativeId: string, usage: Record<string, number>, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  session_id: nativeId,
  parent_tool_use_id: null,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage },
});

const result = (nativeId: string, usage: Record<string, number>, numTurns: number) => ({
  type: 'result',
  subtype: 'success',
  session_id: nativeId,
  result: 'ok',
  duration_ms: 1,
  num_turns: numTurns,
  usage,
});

const boundary = (nativeId: string) => ({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: nativeId,
  uuid: `boundary-${nativeId}`,
  compact_metadata: { trigger: 'manual', pre_tokens: 335_000, post_tokens: 10_000, duration_ms: 1_000 },
});

const init = (nativeId: string) => ({ type: 'system', subtype: 'init', session_id: nativeId });

test('a <synthetic> all-zero assistant publishes nothing, and a later real one still does', async () => {
  const nativeId = 'native-synthetic';
  const sent = await runScripted('app-synthetic', [
    init(nativeId),
    assistant(nativeId, zeroUsage, '<synthetic>'),
    assistant(nativeId, fullUsage),
    result(nativeId, fullUsage, 2),
  ]);

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used), [42_512]);
});

test('an assistant usage missing cache_read_input_tokens publishes nothing', async () => {
  const nativeId = 'native-partial';
  const { cache_read_input_tokens: _omitted, ...partial } = fullUsage;
  const sent = await runScripted('app-partial', [
    init(nativeId),
    assistant(nativeId, partial),
    result(nativeId, partial, 2),
  ]);

  assert.deepEqual(tokenBudgets(sent), []);
});

test('a single-request turn with no assistant usage publishes the result as the fallback', async () => {
  const nativeId = 'native-single';
  const sent = await runScripted('app-single', [init(nativeId), result(nativeId, fullUsage, 1)]);

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used), [42_512]);
});

test('a multi-request turn with no assistant usage publishes nothing from its result', async () => {
  const nativeId = 'native-multi';
  const sent = await runScripted('app-multi', [init(nativeId), result(nativeId, fullUsage, 3)]);

  assert.deepEqual(tokenBudgets(sent), []);
});

test('a zero result after a compact_boundary publishes nothing', async () => {
  const nativeId = 'native-compact-zero';
  const sent = await runScripted('app-compact-zero', [
    init(nativeId),
    boundary(nativeId),
    result(nativeId, zeroUsage, 1),
  ]);

  // The only frame is the boundary's clear (this stream's query offers no
  // getContextUsage); the result adds nothing.
  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('a non-zero single-request result after a compact_boundary still publishes nothing', async () => {
  const nativeId = 'native-compact-nonzero';
  const sent = await runScripted('app-compact-nonzero', [
    init(nativeId),
    boundary(nativeId),
    result(nativeId, fullUsage, 1),
  ]);

  assert.deepEqual(tokenBudgets(sent), [null]);
});

test('a held process gives each turn its own fallback decision', async () => {
  const nativeId = 'native-held';
  const sent = await runScripted('app-held', [
    init(nativeId),
    assistant(nativeId, fullUsage),
    result(nativeId, fullUsage, 1),
    // Second turn: no assistant usage. Had the first turn's flag survived, the
    // fallback would be skipped.
    result(nativeId, { ...fullUsage, cache_read_input_tokens: 50_000 }, 1),
  ]);

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used), [42_512, 52_512]);
});

test('a held process whose follow-up turn compacts publishes nothing from that turn\'s result', async () => {
  const nativeId = 'native-held-compact';
  const sent = await runScripted('app-held-compact', [
    init(nativeId),
    assistant(nativeId, fullUsage),
    result(nativeId, fullUsage, 1),
    boundary(nativeId),
    result(nativeId, zeroUsage, 1),
  ]);

  assert.deepEqual(tokenBudgets(sent).map((budget) => budget?.used ?? null), [42_512, null]);
});

test('a window the SDK reports equal to CONTEXT_WINDOW is still labelled sdk', async () => {
  const previous = process.env.CONTEXT_WINDOW;
  process.env.CONTEXT_WINDOW = '160000';
  try {
    const nativeId = 'native-equal-window';
    const sent = await runScripted('app-equal-window', [
      init(nativeId),
      assistant(nativeId, fullUsage),
      {
        ...result(nativeId, fullUsage, 1),
        modelUsage: { 'claude-opus-5-5': { contextWindow: 160_000, inputTokens: 1, outputTokens: 1 } },
      },
    ]);

    const last = tokenBudgets(sent).at(-1)!;
    assert.equal(last.total, 160_000);
    assert.equal(last.contextWindowSource, 'sdk');
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_WINDOW;
    else process.env.CONTEXT_WINDOW = previous;
  }
});
