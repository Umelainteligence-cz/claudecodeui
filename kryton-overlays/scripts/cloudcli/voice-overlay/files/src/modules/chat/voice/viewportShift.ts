/**
 * How far to move a box sideways so it sits inside the viewport with `margin`
 * to spare on both sides. A box wider than the viewport is left-aligned to the
 * margin (its own max-width is what makes it wrap).
 *
 * Why it exists: the strips and menus the voice overlay and the copy control
 * open are anchored to a small button, and a button near the left edge of a
 * 375-390 px phone leaves half of a centred or right-aligned box off-screen.
 */
export function shiftIntoViewport(left: number, right: number, viewportWidth: number, margin = 8): number {
  if (right - left > viewportWidth - 2 * margin) return margin - left;
  if (left < margin) return margin - left;
  if (right > viewportWidth - margin) return viewportWidth - margin - right;
  return 0;
}
