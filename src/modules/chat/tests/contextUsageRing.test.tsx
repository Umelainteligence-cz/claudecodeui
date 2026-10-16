import type { ComponentProps, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ContextRingSlot,
  formatContextTooltip,
  readContextUsage,
} from '@/modules/chat/composer/ContextUsageRing';
import { CONTEXT_RING_NS, contextRingI18n } from '@/modules/chat/composer/contextRingI18n';
import { setUiPreferences } from '@/modules/chat/voice/tests/kit';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { resetUserPreferences } from '@/shared/userSettings';
import type * as SharedApi from '@/shared/api';

/**
 * The context ring (U3): the pure usage maths and tooltip formatter first, then
 * the ring, its compact confirmation and the slot that decides between the ring
 * and the token pill. The composer wiring is covered by U5's own test.
 */

// Writing a preference queues a server save; keep it off the network.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      user: { ...actual.api.user, savePreferences: async () => ({ ok: true, json: async () => ({}) }) },
    },
  };
});

type SlotProps = ComponentProps<typeof ContextRingSlot>;

const PILL = <button type="button">pill</button>;

function slotProps(overrides: Partial<SlotProps> = {}): SlotProps {
  return {
    provider: 'claude',
    tokenBudget: { used: 42_000, total: 100_000 },
    onCompact: vi.fn(),
    isCompacting: false,
    compactAvailability: { canCompact: true, blockedReason: null },
    compactSessionKey: 'session-1',
    onShowTokenUsage: vi.fn(),
    fallback: PILL,
    ...overrides,
  };
}

const formSubmit = vi.fn((event: FormEvent) => event.preventDefault());
const formKeyDown = vi.fn((_event: ReactKeyboardEvent) => undefined);

/** The slot inside a form with its own handlers, standing in for the composer's. */
function Harness(props: SlotProps) {
  return (
    <UiPreferencesProvider>
      <form onSubmit={formSubmit} onKeyDown={formKeyDown}>
        <ContextRingSlot {...props} />
      </form>
    </UiPreferencesProvider>
  );
}

function renderSlot(overrides: Partial<SlotProps> = {}) {
  const props = slotProps(overrides);
  const view = render(<Harness {...props} />);
  return {
    ...view,
    props,
    update: (next: Partial<SlotProps>) => view.rerender(<Harness {...props} {...next} />),
  };
}

const ring = () => screen.getByRole('button', { name: /kontextu využito|Komprimuji konverzaci/ });
const arc = () => document.querySelector('[data-slot="context-ring-arc"]') as SVGCircleElement;
const dialog = () => screen.queryByRole('dialog', { name: 'Zkomprimovat konverzaci?' });

function openDialog() {
  fireEvent.click(ring());
  const opened = dialog();
  expect(opened).not.toBeNull();
  return opened as HTMLElement;
}

const en = () => contextRingI18n.getFixedT('en', CONTEXT_RING_NS);

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  formSubmit.mockClear();
  formKeyDown.mockClear();
  await contextRingI18n.changeLanguage('cs');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readContextUsage', () => {
  test('measures against the full window without an auto-compact limit', () => {
    expect(readContextUsage({ used: 42_000, total: 100_000 })).toEqual({
      used: 42_000,
      limit: 100_000,
      total: 100_000,
      pct: 42,
      hasAutoCompactLimit: false,
    });
  });

  test('measures against the auto-compact limit when one is given', () => {
    const usage = readContextUsage({ used: 50_000, total: 200_000, autoCompactLimit: 100_000 });
    expect(usage).toMatchObject({ limit: 100_000, total: 200_000, pct: 50, hasAutoCompactLimit: true });
  });

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100000', null])(
    'ignores an auto-compact limit of %s',
    (autoCompactLimit) => {
      const usage = readContextUsage({ used: 50_000, total: 200_000, autoCompactLimit });
      expect(usage).toMatchObject({ limit: 200_000, pct: 25, hasAutoCompactLimit: false });
    },
  );

  test('clamps to 0-100', () => {
    expect(readContextUsage({ used: 300_000, total: 200_000 })?.pct).toBe(100);
    expect(readContextUsage({ used: -10, total: 200_000 })?.pct).toBe(0);
  });

  test.each([
    ['total 0', { used: 10, total: 0 }],
    ['negative total', { used: 10, total: -1 }],
    ['missing total', { used: 10 }],
    ['missing used', { total: 100_000 }],
    ['string used', { used: '10', total: 100_000 }],
    ['NaN used', { used: Number.NaN, total: 100_000 }],
    ['input+output only', { inputTokens: 10, outputTokens: 5, total: 100_000 }],
  ])('returns null for %s', (_label, budget) => {
    expect(readContextUsage(budget)).toBeNull();
  });

  test('returns null for a null or missing budget', () => {
    expect(readContextUsage(null)).toBeNull();
    expect(readContextUsage(undefined)).toBeNull();
  });
});

describe('formatContextTooltip', () => {
  test('with an auto-compact limit: used/limit, the window on its own line, remaining until auto-compact', () => {
    const usage = readContextUsage({ used: 50_000, total: 200_000, autoCompactLimit: 100_000 });
    expect(formatContextTooltip(usage!, en())).toEqual([
      '50K / 100K',
      '200K context window',
      '50% remaining until auto-compact',
    ]);
  });

  test('without one: used/total and plain remaining', () => {
    const usage = readContextUsage({ used: 42_000, total: 160_000 });
    expect(formatContextTooltip(usage!, en())).toEqual(['42K / 160K', '74% remaining']);
  });

  test('remaining follows the rounded number the label shows', () => {
    const usage = readContextUsage({ used: 59_600, total: 100_000 });
    expect(formatContextTooltip(usage!, en())[1]).toBe('40% remaining');
  });

  test('small counts keep one decimal', () => {
    const usage = readContextUsage({ used: 1_500, total: 200_000 });
    expect(formatContextTooltip(usage!, en())[0]).toBe('1.5K / 200K');
  });

  test('Czech copy', () => {
    const usage = readContextUsage({ used: 50_000, total: 200_000, autoCompactLimit: 100_000 });
    expect(formatContextTooltip(usage!, contextRingI18n.getFixedT('cs', CONTEXT_RING_NS))).toEqual([
      '50K / 100K',
      'Kontextové okno 200K',
      'Zbývá 50 % do automatické komprese',
    ]);
  });
});

describe('the ring', () => {
  test.each([
    [59_000, 'text-emerald-500'],
    [59_600, 'text-amber-500'],
    [60_000, 'text-amber-500'],
    [84_000, 'text-amber-500'],
    [85_000, 'text-red-500'],
  ])('%s of 100K renders %s', (used, tone) => {
    renderSlot({ tokenBudget: { used, total: 100_000 } });
    const classes = arc().getAttribute('class') ?? '';
    expect(classes).toContain(tone);
    for (const other of ['text-emerald-500', 'text-amber-500', 'text-red-500'].filter((c) => c !== tone)) {
      expect(classes).not.toContain(other);
    }
  });

  test('the arc is continuous and a full window fills it', () => {
    renderSlot({ tokenBudget: { used: 42_000, total: 100_000 } });
    const circumference = Number(arc().getAttribute('stroke-dasharray'));
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.58, 5);

    renderSlot({ tokenBudget: { used: 300_000, total: 200_000 } });
    const arcs = document.querySelectorAll('[data-slot="context-ring-arc"]');
    expect(Number(arcs[1].getAttribute('stroke-dashoffset'))).toBe(0);
  });

  test('the SVG is hidden from assistive tech; the button carries the label', () => {
    renderSlot();
    const svg = ring().querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(ring().getAttribute('type')).toBe('button');
  });

  test('aria-label for 42 % in Czech', () => {
    renderSlot();
    expect(ring().getAttribute('aria-label')).toBe('42 % kontextu využito — kliknutím zkomprimujete');
  });

  test('aria-label in English', async () => {
    await contextRingI18n.changeLanguage('en');
    renderSlot();
    expect(screen.getByRole('button', { name: '42% context used — click to compact' })).toBeTruthy();
  });

  test('while compacting: aria-busy, the compacting label and a reduced-motion-safe pulse', () => {
    renderSlot({ isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    expect(ring().getAttribute('aria-busy')).toBe('true');
    expect(ring().getAttribute('aria-label')).toBe('Komprimuji konverzaci…');
    expect(ring().getAttribute('class')).toContain('motion-safe:animate-pulse');
  });

  test('hovering shows the tooltip after 350ms; it is hidden while the dialog is open', () => {
    vi.useFakeTimers();
    renderSlot();
    fireEvent.mouseEnter(ring());
    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(document.querySelector('[data-slot="context-ring-tooltip"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const content = document.querySelector('[data-slot="context-ring-tooltip"]') as HTMLElement;
    expect(content.textContent).toContain('42K / 100K');
    expect(content.textContent).toContain('Zbývá 58 %');
    expect(content.closest('div')?.className).not.toMatch(/\bhidden\b/);

    const trigger = ring();
    openDialog();
    const hiddenContent = document.querySelector('[data-slot="context-ring-tooltip"]') as HTMLElement;
    expect(hiddenContent.closest('div')?.className).toMatch(/\bhidden\b/);
    // Hiding by class rather than clearing the content keeps the same button mounted.
    expect(ring()).toBe(trigger);
  });
});

describe('the compact confirmation', () => {
  test('click opens a non-modal dialog labelled by its title; Zrušit has focus', () => {
    renderSlot();
    const opened = openDialog();
    expect(opened.getAttribute('aria-modal')).toBe('false');
    expect(ring().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zrušit' }));
    expect(opened.textContent).toContain('Claude shrne dosavadní průběh, aby uvolnil místo v kontextu.');
    // The usage and remaining lines repeat in the dialog for touch and keyboard users.
    expect(opened.textContent).toContain('42K / 100K');
    expect(opened.textContent).toContain('Zbývá 58 %');
  });

  test('the body is part of the description', () => {
    renderSlot();
    const opened = openDialog();
    const described = (opened.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = described.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('Claude shrne dosavadní průběh, aby uvolnil místo v kontextu.');
  });

  test('Enter right after opening does not compact', () => {
    const { props } = renderSlot();
    openDialog();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(props.onCompact).not.toHaveBeenCalled();
  });

  test('Zrušit closes, calls nothing and returns focus to the ring', () => {
    const { props } = renderSlot();
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Zrušit' }));
    expect(dialog()).toBeNull();
    expect(props.onCompact).not.toHaveBeenCalled();
    expect(props.onShowTokenUsage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ring());
  });

  test('Escape closes, is default-prevented and returns focus to the ring', () => {
    const { props } = renderSlot();
    openDialog();
    const notPrevented = fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(ring());
    expect(props.onCompact).not.toHaveBeenCalled();
  });

  test('Zkomprimovat compacts once, closes and returns focus to the ring', () => {
    const { props } = renderSlot();
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Zkomprimovat' }));
    expect(props.onCompact).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(ring());
  });

  test('Podrobnosti opens the token breakdown and closes', () => {
    const { props } = renderSlot();
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Podrobnosti' }));
    expect(props.onShowTokenUsage).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  test('an outside click closes without pulling focus back to the ring', () => {
    renderSlot();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    openDialog();
    elsewhere.focus();
    fireEvent.pointerDown(elsewhere);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  test('Enter or Space on a dialog button never reaches the surrounding form', () => {
    const { props } = renderSlot();
    for (const name of ['Zrušit', 'Zkomprimovat', 'Podrobnosti']) {
      openDialog();
      const button = screen.getByRole('button', { name });
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.keyDown(button, { key: ' ' });
      fireEvent.click(button);
    }
    expect(formKeyDown).not.toHaveBeenCalled();
    expect(formSubmit).not.toHaveBeenCalled();
    expect(props.onCompact).toHaveBeenCalledTimes(1);
  });

  test('a blocked compact is disabled and says why, as part of the description', () => {
    const { props } = renderSlot({ compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    const opened = openDialog();
    const compact = screen.getByRole('button', { name: 'Zkomprimovat' }) as HTMLButtonElement;
    expect(compact.disabled).toBe(true);
    const reason = screen.getByText('Počkejte, až Claude dokončí odpověď.');
    expect(reason.id).not.toBe('');
    expect((opened.getAttribute('aria-describedby') ?? '').split(' ')).toContain(reason.id);
    fireEvent.click(compact);
    expect(props.onCompact).not.toHaveBeenCalled();
  });

  test('opening while compacting shows Zkomprimovat disabled with the busy reason', () => {
    renderSlot({ isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    openDialog();
    expect((screen.getByRole('button', { name: 'Zkomprimovat' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Počkejte, až Claude dokončí odpověď.')).toBeTruthy();
  });

  test('a session change closes the dialog', () => {
    const { update } = renderSlot();
    openDialog();
    update({ compactSessionKey: 'session-2' });
    expect(dialog()).toBeNull();
  });

  test('the dialog goes away with the ring', () => {
    const { update } = renderSlot();
    openDialog();
    update({ tokenBudget: null });
    expect(dialog()).toBeNull();
    expect(screen.getByRole('button', { name: 'pill' })).toBeTruthy();
  });
});

describe('ContextRingSlot', () => {
  test('renders the ring, not the pill, for Claude with a valid budget', () => {
    renderSlot();
    expect(ring()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'pill' })).toBeNull();
  });

  test.each([
    ['another provider', { provider: 'codex' }],
    ['no budget', { tokenBudget: null }],
    ['a zero total', { tokenBudget: { used: 10, total: 0 } }],
    ['no compact action', { onCompact: undefined }],
  ] as Array<[string, Partial<SlotProps>]>)('renders the pill for %s', (_label, overrides) => {
    renderSlot(overrides);
    expect(screen.getByRole('button', { name: 'pill' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /kontextu využito/ })).toBeNull();
  });

  test('renders the pill when the preference is off', async () => {
    await setUiPreferences({ showContextRing: false });
    renderSlot();
    expect(screen.getByRole('button', { name: 'pill' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /kontextu využito/ })).toBeNull();
  });

  test('with no budget the markup is exactly the pill', () => {
    const { container } = renderSlot({ tokenBudget: null });
    const { container: bare } = render(
      <UiPreferencesProvider>
        <form onSubmit={formSubmit} onKeyDown={formKeyDown}>{PILL}</form>
      </UiPreferencesProvider>,
    );
    expect(container.innerHTML).toBe(bare.innerHTML);
  });

  test('announces the start and the end of a compact, even after the ring is gone', () => {
    const { update } = renderSlot();
    const status = screen.getByRole('status');
    expect(status.className).toContain('sr-only');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');

    update({ isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    expect(screen.getByRole('status').textContent).toBe('Komprimuji konverzaci.');

    // Lane A may send a null budget after a manual compact: the ring goes, the
    // pill comes back, and the end is still announced.
    update({ isCompacting: false, tokenBudget: null });
    expect(screen.queryByRole('button', { name: /kontextu využito/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'pill' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Konverzace je zkomprimovaná.');
  });

  test('switching sessions away from a running compact announces nothing', () => {
    const { update } = renderSlot();
    update({ isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    expect(screen.getByRole('status').textContent).toBe('Komprimuji konverzaci.');

    update({ isCompacting: false, compactSessionKey: 'session-2' });
    expect(screen.getByRole('status').textContent).not.toBe('Konverzace je zkomprimovaná.');

    // Coming back to the compact still running is not a new start either.
    update({ isCompacting: true, compactSessionKey: 'session-1', compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    expect(screen.getByRole('status').textContent).not.toBe('Komprimuji konverzaci.');
  });

  test('a dropped connection does not announce the compact as finished', () => {
    const { update } = renderSlot();
    update({ isCompacting: true, compactAvailability: { canCompact: false, blockedReason: 'busy' } });
    update({ isCompacting: false, compactAvailability: { canCompact: false, blockedReason: 'offline' } });
    expect(screen.getByRole('status').textContent).not.toBe('Konverzace je zkomprimovaná.');
  });
});
