import assert from 'node:assert/strict';
import test from 'node:test';

import { runScripted } from '@/modules/providers/tests/scripted-claude-sdk.js';

/**
 * Proves the scripted-SDK harness: a scripted init -> assistant -> result
 * stream flows through the real runtime loop, without spawning a CLI.
 */
test('a scripted stream yields a token_budget and a complete frame', async () => {
  const nativeId = 'native-scripted';
  const usage = { input_tokens: 12, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 500 };
  const sent = await runScripted('app-scripted', [
    { type: 'system', subtype: 'init', session_id: nativeId },
    {
      type: 'assistant',
      session_id: nativeId,
      parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage },
    },
    { type: 'result', subtype: 'success', session_id: nativeId, result: 'ok', duration_ms: 1, num_turns: 1, usage },
  ]);

  const budget = sent.find((message) => message.kind === 'status' && message.text === 'token_budget');
  assert.ok(budget, 'expected a token_budget frame');
  assert.equal((budget.tokenBudget as { used: number }).used, 42_512);
  assert.ok(sent.some((message) => message.kind === 'complete'), 'expected a complete frame');
});
