import { createRef } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';

/**
 * jsdom lays nothing out, so the trigger's rect and the viewport are stubbed.
 * The 'start' alignment exists for triggers in the left toolbar group, which
 * the right-anchored default would push off the left edge on a phone.
 */

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function setViewport(width: number, height: number) {
  window.innerWidth = width;
  window.innerHeight = height;
}

// Stable, like the callers' `close`: a fresh function each render would re-run the open effect forever.
const onClose = () => {};

function mountHook(
  rect: { left: number; right: number; top: number },
  options: { isOpen?: boolean; width?: number; align?: 'start' | 'end' } = {},
) {
  const { isOpen = true, width, align } = options;
  const hook = renderHook(
    ({ open }) => useComposerMenuAnchor(open, onClose, width, align),
    { initialProps: { open: false } },
  );
  const trigger = document.createElement('button');
  trigger.getBoundingClientRect = () => ({ ...rect, bottom: rect.top + 32, width: 0, height: 32, x: rect.left, y: rect.top, toJSON: () => ({}) });
  hook.result.current.triggerRef.current = trigger;
  if (isOpen) {
    hook.rerender({ open: true });
  }
  return hook;
}

describe('useComposerMenuAnchor', () => {
  beforeEach(() => setViewport(375, 700));
  afterEach(() => setViewport(originalWidth, originalHeight));

  test('start alignment anchors to the trigger left edge and fits the viewport', () => {
    const { result } = mountHook({ left: 16, right: 48, top: 600 }, { align: 'start' });
    expect(result.current.anchor).toEqual({
      left: 16,
      bottom: 700 - 600 + 8,
      maxHeight: 600 - 8 - 8,
      maxWidth: 320,
    });
    expect(result.current.anchor).not.toHaveProperty('right');
  });

  test('start alignment shrinks below the 200px floor instead of overflowing', () => {
    setViewport(260, 700);
    const { result } = mountHook({ left: 100, right: 132, top: 600 }, { align: 'start' });
    expect(result.current.anchor).toMatchObject({ left: 100, maxWidth: 260 - 100 - 8 });
  });

  test('start alignment never reports a negative maxWidth', () => {
    setViewport(100, 700);
    const { result } = mountHook({ left: 120, right: 152, top: 600 }, { align: 'start' });
    expect(result.current.anchor).toMatchObject({ left: 120, maxWidth: 0 });
  });

  test('start alignment caps maxWidth at 351 for a 375px viewport', () => {
    const { result } = mountHook({ left: 16, right: 48, top: 600 }, { align: 'start', width: 1000 });
    expect(result.current.anchor).toMatchObject({ left: 16, maxWidth: 351 });
  });

  test('start alignment clamps a trigger hugging the edge to the 8px margin', () => {
    const { result } = mountHook({ left: 2, right: 34, top: 600 }, { align: 'start' });
    expect(result.current.anchor).toMatchObject({ left: 8 });
  });

  test('the default alignment keeps the right-anchored values', () => {
    const { result } = mountHook({ left: 300, right: 340, top: 600 });
    expect(result.current.anchor).toEqual({
      right: 375 - 340,
      bottom: 108,
      maxHeight: 584,
      maxWidth: Math.max(200, Math.min(320, 375 - 35 - 8)),
    });
    expect(result.current.anchor).not.toHaveProperty('left');
  });

  test('the default alignment still floors the width at 200px', () => {
    setViewport(220, 700);
    const { result } = mountHook({ left: 10, right: 100, top: 600 });
    expect(result.current.anchor).toMatchObject({ right: 120, maxWidth: 200 });
  });

  test('no anchor is computed while closed', () => {
    const { result } = mountHook({ left: 16, right: 48, top: 600 }, { isOpen: false, align: 'start' });
    expect(result.current.anchor).toBeNull();
    act(() => result.current.updateAnchor());
    expect(result.current.anchor).not.toBeNull();
  });
});

describe('ComposerMenuSurface', () => {
  test('defaults to role menu and positions by right', () => {
    render(
      <ComposerMenuSurface anchor={{ right: 8, bottom: 40, maxHeight: 300, maxWidth: 320 }} menuRef={createRef()} ariaLabel="Menu">
        body
      </ComposerMenuSurface>,
    );
    const surface = screen.getByRole('menu');
    expect(surface.style.right).toBe('8px');
    expect(surface.style.left).toBe('');
  });

  test('renders a dialog positioned by left with its aria attributes', () => {
    render(
      <>
        <p id="t">Title</p>
        <ComposerMenuSurface
          anchor={{ left: 16, bottom: 40, maxHeight: 300, maxWidth: 320 }}
          menuRef={createRef()}
          role="dialog"
          ariaModal={false}
          ariaLabelledBy="t"
          ariaDescribedBy="d"
        >
          body
        </ComposerMenuSurface>
      </>,
    );
    const surface = screen.getByRole('dialog');
    expect(surface.style.left).toBe('16px');
    expect(surface.style.right).toBe('');
    expect(surface.getAttribute('aria-modal')).toBe('false');
    expect(surface.getAttribute('aria-labelledby')).toBe('t');
    expect(surface.getAttribute('aria-describedby')).toBe('d');
    expect(surface.hasAttribute('aria-label')).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
