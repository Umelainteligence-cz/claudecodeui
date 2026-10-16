import { describe, expect, it } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * A `/compact` turn as the server hands it to the client, live and from
 * history. The rows mirror `claude-live-compaction-parity.test.ts`, which
 * checks the server side of the same session.
 */

let nextId = 0;
const row = (fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: `row-${(nextId += 1)}`,
  sessionId: 's1',
  timestamp: '2026-10-16T15:44:04.839Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  ...fields,
} as NormalizedMessage);

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';
const HOOK_ACK = 'Compacted PostCompact [hook.cmd] completed successfully: {}';

const prompt = (content: string, fields: Partial<NormalizedMessage> = {}) => row({ role: 'user', content, ...fields });
const answer = (content: string) => row({ content });
const running = () => row({ content: 'Compacting conversation…', compact: { phase: 'running' } });
const boundary = () => row({
  content: 'Compacted · manual · 46k → 6k tokens · 8s',
  compact: { phase: 'done', trigger: 'manual', preTokens: 46_415, postTokens: 6_364, durationMs: 8_285 },
});
const summary = () => row({ content: SUMMARY, isCompactSummary: true });
const ack = () => row({ content: HOOK_ACK, isLocalCommandStdout: true });

/** What the reader sees in each row. */
const seen = (messages: ChatMessage[]) => messages.map((message) => ({
  type: message.type,
  content: message.content,
  compactPhase: message.compact?.phase,
  compactSummary: message.compactSummary,
}));

describe('the live compaction row', () => {
  it('draws the streamed sequence (boundary, summary, acknowledgement) as exactly one row', () => {
    const converted = normalizedToChatMessages([boundary(), summary(), ack()]);

    expect(seen(converted)).toEqual([{
      type: 'assistant',
      content: 'Compacted · manual · 46k → 6k tokens · 8s',
      compactPhase: 'done',
      compactSummary: SUMMARY,
    }]);
  });

  it('draws the same transcript live as after a reload', () => {
    const live = normalizedToChatMessages([
      prompt('Write ten short sentences.'),
      answer('1. In 1817 Karl Drais built the running machine.'),
      prompt('/compact'),
      running(),
      boundary(),
      summary(),
      ack(),
      prompt('Now write three more.'),
    ]);
    // History orders by timestamp, which puts the summary a moment before its
    // boundary, and marks the command as the local command it was.
    const reloaded = normalizedToChatMessages([
      prompt('Write ten short sentences.'),
      answer('1. In 1817 Karl Drais built the running machine.'),
      prompt('/compact', { isLocalCommand: true, commandName: '/compact' }),
      summary(),
      boundary(),
      ack(),
      prompt('Now write three more.'),
    ]);

    expect(seen(live)).toEqual(seen(reloaded));
    expect(live.filter((message) => message.compact)).toHaveLength(1);
    expect(live.some((message) => (message.content || '').startsWith('<'))).toBe(false);
  });
});
