import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { APP_VERSION } from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

/**
 * CC9 (operator Q1670 = A1, 24. 10. 2026), against the EDITED upstream hook: the
 * app is updated with the workspace image, so the hook never asks GitHub for a
 * release and never reports one - the Update badge, the footer line and the
 * upgrade modal all hang on `updateAvailable`. The /health call stays (it feeds
 * the restart hint). Upstream polls releases/latest on mount and every 5 minutes;
 * the fake answers a far newer release, so the unedited hook fails both asserts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('useVersionCheck never fetches a GitHub release and never reports an update', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === '/health'
      ? { status: 'ok', installMode: 'npm', version: APP_VERSION }
      : { tag_name: 'v999.0.0', name: 'v999.0.0', body: '', html_url: 'https://example.invalid', published_at: '2026-10-24T00:00:00Z' };
    return { json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  const { result } = renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/health'));
  // Let any other effect of the mount settle before judging what was fetched.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const urls = fetchMock.mock.calls.map(([input]) => String(input));
  expect(urls.filter((url) => /github/i.test(url))).toEqual([]);
  expect(result.current.updateAvailable).toBe(false);
  expect(result.current.latestVersion).toBeNull();
  expect(result.current.releaseInfo).toBeNull();
});

test('the 5-minute poll is gone too: no GitHub fetch after time passes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ json: async () => ({ tag_name: 'v999.0.0' }) }) as Response);
  vi.stubGlobal('fetch', fetchMock);

  const { result } = renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));
  await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

  const urls = fetchMock.mock.calls.map(([input]) => String(input));
  expect(urls.filter((url) => /github/i.test(url))).toEqual([]);
  expect(result.current.updateAvailable).toBe(false);
});
