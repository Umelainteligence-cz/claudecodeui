import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Test harness for loop-level Claude runtime tests. Consumers: the
 * claude-*.test.ts suites that need `queryClaudeSDK` driven by a scripted SDK
 * stream instead of a real CLI process. Not a test file itself (no `.test`
 * suffix), so the test glob skips it.
 */

export type ScriptedMessage = Record<string, unknown>;

export type RunScriptedOptions = {
  /** Provider-native session id the app session resumes from, if any. */
  resumeProviderSessionId?: string | null;
  /** Stub for the fake query's `getContextUsage()` control request. */
  getContextUsage?: () => Promise<unknown>;
  /** Overrides the runtime's `getContextUsage()` timeout so tests stay fast. */
  contextUsageTimeoutMs?: number;
  /** Model the session requests (`options.model`); omitted when unset. */
  model?: string;
};

/**
 * Drives `queryClaudeSDK` through one scripted SDK stream and returns every
 * message it sent. The run ends deterministically: the stream drains, the loop
 * finishes, and the runtime's `finally` clears the idle-release timer and
 * releases the held prompt, so nothing survives between tests.
 */
export async function runScripted(
  appSessionId: string,
  stream: ScriptedMessage[],
  options: RunScriptedOptions = {},
): Promise<NormalizedMessage[]> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-scripted-sdk-'));
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => options.resumeProviderSessionId ?? null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    contextUsageTimeoutMs: options.contextUsageTimeoutMs,
    createQuery: ({ prompt }) => {
      // Drain the held prompt like the CLI would read its stdin; it ends when
      // the runtime releases the prompt.
      void (async () => { for await (const _message of prompt) { /* read */ } })();
      const iterator = (async function* () { yield* stream; })();
      return Object.assign(iterator, {
        interrupt: async () => {},
        ...(options.getContextUsage ? { getContextUsage: options.getContextUsage } : {}),
      }) as never;
    },
  };

  try {
    await queryClaudeSDK('hello', { sessionId: appSessionId, cwd, ...(options.model ? { model: options.model } : {}) }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return sent;
}
