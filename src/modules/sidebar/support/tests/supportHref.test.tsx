import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import cases from '@/modules/sidebar/support/supportHrefCases.json';
import {
  ME_RETRY_DELAYS_MS,
  SUPPORT_GUIDE_SLUG,
  readMeOnce,
  resetSupportHrefForTests,
  supportHrefFor,
} from '@/modules/sidebar/support/supportHref';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';

/**
 * Kryton support overlay (plan ccl-r262, P1, K1). "Nahlásit problém" opens the help window of the
 * centre on the support guide; the upstream issue tracker and community chat are gone from the
 * footer, the mobile menu and the collapsed rail. The address follows the plugin "Nastavení
 * pracovny" (one table, supportHrefCases.json, checked against the plugin by
 * scripts/cloudcli-support-overlay.test.js) and is never guessed before /user-auth/me answers.
 */

const t = ((key: string) => (key === 'actions.reportIssue' ? 'Report Issue' : key)) as unknown as TFunction;

const footer = () => (
  <SidebarFooter
    updateAvailable={false}
    restartRequired={false}
    releaseInfo={null}
    latestVersion={null}
    currentVersion="1.37.3"
    onShowVersionModal={() => undefined}
    onShowSettings={() => undefined}
    t={t}
  />
);
const collapsed = () => (
  <SidebarCollapsed
    onExpand={() => undefined}
    onShowSettings={() => undefined}
    updateAvailable={false}
    restartRequired={false}
    onShowVersionModal={() => undefined}
    t={t}
  />
);

const answer = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

let release: (() => void) | null;
beforeEach(() => {
  resetSupportHrefForTests();
  release = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const upstreamLinks = (container: HTMLElement) =>
  container.querySelectorAll('a[href*="discord"], a[href*="siteboon/claudecodeui/issues"]').length;

test('one table, the plugin\'s answers: centre = parent host, company server = edge.central_url only', () => {
  for (const c of cases.cases) {
    const got = supportHrefFor(c.me, c.host, c.lang);
    assert.equal(got, c.expected === null ? null : `${c.expected}&n=${SUPPORT_GUIDE_SLUG}`, c.name);
  }
});

test('no usable /user-auth/me answer = no link', async () => {
  assert.equal(supportHrefFor(null, 'cloudcli.kryton.example.com', 'cs'), null);
  for (const reply of [answer(401, {}), answer(500, {}), answer(200, { nope: 1 }), Promise.reject(new Error('net'))]) {
    resetSupportHrefForTests();
    assert.equal(await readMeOnce(() => reply), null);
  }
});

test('the footer draws "Report Issue" only after /me answered, with the centre address, and no upstream links ever', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => ({ username: 'alice', edge: null }) } as Response);
  })));
  const { container } = render(footer());
  assert.equal(screen.queryAllByText('Report Issue').length, 0, 'not drawn before /me answers');
  assert.equal(upstreamLinks(container), 0);
  release!();
  await waitFor(() => assert.equal(screen.getAllByText('Report Issue').length, 2)); // desktop + mobile
  const hrefs = screen.getAllByText('Report Issue').map((el) => el.closest('a')!.getAttribute('href'));
  for (const href of hrefs) {
    assert.match(href!, /\/user-auth\/napoveda\?lang=(cs|en)&n=how-support-contacts-you$/);
  }
  for (const a of screen.getAllByText('Report Issue').map((el) => el.closest('a')!)) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
  }
  assert.equal(upstreamLinks(container), 0);
  assert.equal(screen.queryAllByText('actions.joinCommunity').length, 0, 'the community chat row is gone');
});

test('a company server without central_url, or a refused /me, never draws the button (no edge address instead of the centre)', async () => {
  for (const reply of [{ status: 200, body: { username: 'alice', edge: { central_url: null } } }, { status: 401, body: {} }]) {
    resetSupportHrefForTests();
    const fetchMock = vi.fn(() => answer(reply.status, reply.body));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(footer());
    await waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
    await Promise.resolve();
    assert.equal(screen.queryAllByText('Report Issue').length, 0, JSON.stringify(reply));
    assert.equal(upstreamLinks(view.container), 0);
    view.unmount();
  }
});

test('the collapsed rail: the support icon after /me, no community icon, one shared read', async () => {
  const fetchMock = vi.fn(() => answer(200, { username: 'alice', edge: { central_url: 'https://kryton.example.com' } }));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<>{collapsed()}{footer()}</>);
  await waitFor(() => assert.ok(container.querySelector('a[aria-label="Report Issue"]')));
  const href = container.querySelector('a[aria-label="Report Issue"]')!.getAttribute('href');
  assert.match(href!, /^https:\/\/kryton\.example\.com\/user-auth\/napoveda\?lang=(cs|en)&n=how-support-contacts-you$/);
  assert.equal(container.querySelector('a[aria-label="actions.joinCommunity"]'), null);
  assert.equal(upstreamLinks(container), 0);
  assert.equal(fetchMock.mock.calls.length, 1, 'the rail and the footer share one /me read');
});

test('a failed /me read is not kept: the footer retries and draws the button once /me answers', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let calls = 0;
    const fetchMock = vi.fn(() => (++calls === 1 ? Promise.reject(new Error('blip')) : answer(200, { username: 'alice', edge: null })));
    vi.stubGlobal('fetch', fetchMock);
    render(footer());
    await waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
    assert.equal(screen.queryAllByText('Report Issue').length, 0, 'hidden after the failed read');
    await vi.advanceTimersByTimeAsync(ME_RETRY_DELAYS_MS[0]);
    await waitFor(() => assert.equal(screen.getAllByText('Report Issue').length, 2));
    assert.equal(fetchMock.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});
