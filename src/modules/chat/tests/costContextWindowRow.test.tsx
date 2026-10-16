import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { CostCommandData } from '@/shared/types';

afterEach(cleanup);

// The props below the payload only matter to the /models view; the cost view ignores them.
const renderCost = (data: CostCommandData) =>
  render(
    <CommandResultModal
      payload={{ kind: 'cost', data }}
      onClose={vi.fn()}
      providerModelCatalog={{}}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn() }}
      activeProvider="claude"
      activeProviderModel="default"
      currentSessionId={null}
      onSelectProviderModel={vi.fn()}
    />,
  );

// The default text matcher collapses the no-break space some locales put in grouped numbers.
const hasValue = (value: number) =>
  screen.getByText((_, element) => element?.textContent === value.toLocaleString() && element.children.length === 0);

describe('/cost context window row', () => {
  it('shows the window when the SDK reported it', () => {
    renderCost({ tokenUsage: { used: 41_000, total: 1_000_000, contextWindowSource: 'sdk' } });
    expect(screen.getByText('Context window')).toBeTruthy();
    expect(hasValue(1_000_000)).toBeTruthy();
  });

  it.each(['env', 'default'] as const)(
    'hides the window when it only comes from %s, whatever the numbers are',
    (contextWindowSource) => {
      renderCost({ tokenUsage: { used: 41_000, total: 1_000_000, contextWindowSource } });
      expect(screen.getByText('Total tokens used')).toBeTruthy();
      expect(screen.queryByText('Context window')).toBeNull();
    },
  );

  it('keeps the row for a budget that names no source (Codex-shaped)', () => {
    renderCost({ tokenUsage: { used: 12_000, total: 258_400 } });
    expect(screen.getByText('Context window')).toBeTruthy();
    expect(hasValue(258_400)).toBeTruthy();
  });

  it('reads Unknown, with no zero reading and no window row, when there is no usage', () => {
    renderCost({ provider: 'claude', model: 'opus' });
    const row = screen.getByText('Total tokens used').closest('div')?.parentElement;
    expect(row?.textContent).toContain('Unknown');
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('Context window')).toBeNull();
  });
});
