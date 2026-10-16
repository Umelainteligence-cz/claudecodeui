import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

/**
 * The compaction row is one line: a dot that says how the compaction ended, the
 * numbers (or a fallback label), and the folded summary behind a disclosure.
 * Asserted on the rendered DOM because the dot is only a coloured span.
 */

const createDiff = (): DiffLine[] => [];

const compactionRow = (fields: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-16T10:00:00.000Z',
  compact: { phase: 'done' },
  ...fields,
} as ChatMessage);

const renderRow = (message: ChatMessage) => render(
  <UiPreferencesProvider>
    <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
  </UiPreferencesProvider>,
);

const dotOf = (container: HTMLElement) => {
  const dot = container.querySelector('span.rounded-full');
  assert.ok(dot, 'expected the phase dot to render');
  return dot.className;
};

test('a done compaction shows its text, the grey dot and the folded summary behind a disclosure', () => {
  const { container } = renderRow(compactionRow({
    content: 'Compacted · manual · 335k → 10k tokens',
    compactSummary: 'The summary body',
  }));

  assert.match(container.textContent ?? '', /Compacted · manual · 335k → 10k tokens/);
  const dot = dotOf(container);
  assert.match(dot, /bg-gray-400/);
  assert.doesNotMatch(dot, /animate-pulse|bg-red-400|bg-amber-400/);

  const details = container.querySelector('details');
  assert.ok(details, 'expected a disclosure for the summary');
  assert.equal(details.querySelector('summary')?.textContent, 'full summary');
  assert.match(details.textContent ?? '', /The summary body/);
});

test('a failed compaction shows the red dot', () => {
  const { container } = renderRow(compactionRow({
    content: 'Compaction failed: context still too large',
    compact: { phase: 'failed', error: 'context still too large' },
  }));

  const dot = dotOf(container);
  assert.match(dot, /bg-red-400/);
  assert.doesNotMatch(dot, /animate-pulse/);
});

test('a running compaction shows the pulsing amber dot', () => {
  const { container } = renderRow(compactionRow({
    content: 'Compacting conversation…',
    compact: { phase: 'running' },
  }));

  const dot = dotOf(container);
  assert.match(dot, /animate-pulse/);
  assert.match(dot, /bg-amber-400/);
});

test('a compaction with no content shows the "Compacted" label and no disclosure', () => {
  const { container } = renderRow(compactionRow({ content: '' }));

  assert.equal(container.textContent?.trim(), 'Compacted');
  assert.equal(container.querySelector('details'), null);
});
