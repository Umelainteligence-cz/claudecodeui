import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const readFileBlob = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
}));

/**
 * Red Dwarf (cli2): a chat image must never become a GET against CloudCLI's own
 * routes. The browser sends the workspace cookie with a same-origin <img src>,
 * the in-container gate lets `Sec-Fetch-Site: same-origin` through, and some
 * GET routes change state (`/api/projects/clone-progress` clones a repository).
 * A model reply shaped by prompt injection can write such an image, so the
 * renderer refuses the app's own origin and every `/api/` path: no request at
 * all, only the alt-text label.
 */

const OBJECT_URL = 'blob:mock-image';
URL.createObjectURL = vi.fn(() => OBJECT_URL);
URL.revokeObjectURL = vi.fn();

beforeEach(() => {
  readFileBlob.mockReset();
  readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
});

const renderInProject = (markdown: string) =>
  render(
    <MarkdownWorkspaceContext.Provider value={{ projectId: 'project-1' }}>
      <Markdown>{markdown}</Markdown>
    </MarkdownWorkspaceContext.Provider>,
  );

const STATEFUL = '/api/projects/clone-progress?githubUrl=https%3A%2F%2Fgithub.com%2Fa%2Fb&path=x';

const assertRefused = (src: string) => {
  const { queryByRole, getByText, unmount } = renderInProject(`![zakazano](<${src}>)`);
  // A boolean, never the element: a failing assert carrying a DOM node as `actual`
  // makes vitest serialize the whole jsdom graph (30. 10. 2026: 63 GB, workspace froze).
  assert.ok(queryByRole('img') === null, `${src} became an <img>`);
  getByText('zakazano');
  unmount();
};

test('an absolute URL on the app origin is not loaded, only labelled', () => {
  assertRefused(`${window.location.origin}${STATEFUL}`);
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('the same origin spelled differently (upper case, backslash, scheme-relative path) is refused too', () => {
  const { protocol, host } = window.location;
  assertRefused(`${protocol.toUpperCase()}//${host.toUpperCase()}${STATEFUL}`);
  // One backslash after markdown unescaping: the URL parser reads it as a slash.
  assertRefused(`${protocol}\\\\\\\\${host}${STATEFUL}`);
  // `http:/api/...` with an http page is a same-origin path, not another host.
  assertRefused(`${protocol}${STATEFUL}`);
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('the own host on another scheme or port is refused too (a browser upgrades mixed-content images to https)', () => {
  const { protocol, hostname } = window.location;
  const other = protocol === 'https:' ? 'http:' : 'https:';
  assertRefused(`${other}//${hostname}${STATEFUL}`);
  assertRefused(`${other}//${hostname}:443${STATEFUL}`);
  assertRefused(`${protocol}//${hostname}:9${STATEFUL}`);
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('a path starting with /api/ is not fetched through the files route either', () => {
  for (const src of [STATEFUL, '/API/projects/clone-progress', '/api/auth/status']) {
    assertRefused(src);
  }
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('a workspace folder named api, written relatively, still loads', async () => {
  const { findByRole } = renderInProject('![schema](api/schema.png)');

  await findByRole('img');
  assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', 'api/schema.png']);
});

test('another origin still loads as before (the CSP of the edge decides about those)', () => {
  const { getByRole } = renderInProject('![logo](https://example.com/logo.png)');

  assert.equal((getByRole('img') as HTMLImageElement).getAttribute('src'), 'https://example.com/logo.png');
  assert.equal(readFileBlob.mock.calls.length, 0);
});
