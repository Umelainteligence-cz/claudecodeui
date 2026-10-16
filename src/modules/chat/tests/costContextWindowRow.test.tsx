import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CostContent } from '@/modules/chat/modals/CommandResultModal';
import type { CostCommandData } from '@/shared/types';

const render = (data: CostCommandData) =>
  renderToStaticMarkup(React.createElement(CostContent, { data }));

describe('/cost context window row', () => {
  it('shows the window when the SDK reported it', () => {
    const html = render({
      tokenUsage: { used: 41_000, total: 1_000_000, contextWindowSource: 'sdk' },
    });
    expect(html).toContain('Context window');
    expect(html).toContain((1_000_000).toLocaleString());
  });

  it.each(['env', 'default'] as const)(
    'hides the window when it only comes from %s, whatever the numbers are',
    (contextWindowSource) => {
      const html = render({ tokenUsage: { used: 41_000, total: 1_000_000, contextWindowSource } });
      expect(html).not.toContain('Context window');
    },
  );

  it('keeps the row for a budget that names no source (Codex-shaped)', () => {
    const html = render({ tokenUsage: { used: 12_000, total: 258_400 } });
    expect(html).toContain('Context window');
    expect(html).toContain((258_400).toLocaleString());
  });

  it('reads Unknown, with no zero reading and no window row, when there is no usage', () => {
    const html = render({ provider: 'claude', model: 'opus' });
    expect(html).toContain('Total tokens used');
    expect(html).toContain('Unknown');
    expect(html).not.toContain('Context window');
    expect(html).not.toMatch(/>0</);
  });
});
