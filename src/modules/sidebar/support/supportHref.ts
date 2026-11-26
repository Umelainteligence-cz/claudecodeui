import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Kryton support overlay (plan ccl-r262, P1). "Nahlásit problém" leads to OUR support, never to
 * the upstream project: the help window of the Red Dwarf centre, opened on the guide "Jak s tebou
 * komunikuje podpora" (the first contact is the firm's administrator; the window adds the
 * platform's e-mail above the guide). The address of the centre is worked out the same way the
 * plugin "Nastavení pracovny" does it (`windowHref()` in extension/kryton-setup-cloudcli/index.js;
 * one table of cases, `supportHrefCases.json`, holds both to the same answers):
 *   - a company server (`edge` is an object in GET /user-auth/me): only `edge.central_url`, and only
 *     as a bare `https://<host>`; without it there is no link;
 *   - the centre itself: the parent host of this tab (cloudcli.<domain> -> <domain>).
 * Until /user-auth/me has answered, or when it fails, there is NO link (the button is not drawn):
 * a guess would send a company-server user to that server's edge instead of the centre.
 */

export const SUPPORT_WINDOW_PATH = '/user-auth/napoveda';
export const SUPPORT_GUIDE_SLUG = 'how-support-contacts-you';

type MeAnswer = { edge?: unknown } | null | undefined;

const isEdgeObject = (edge: unknown): edge is Record<string, unknown> =>
  !!edge && typeof edge === 'object' && !Array.isArray(edge);

/** `edge.central_url` only as `https://<host>` (no path, user or port); anything else is null. */
export const centralUrlFromMe = (value: unknown): string | null =>
  typeof value === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(value) ? value : null;

/**
 * The link of "Nahlásit problém" for one /user-auth/me answer, or null (= no button).
 * `me` null/undefined = no usable answer yet. `lang` is reduced to cs|en like the plugin does.
 */
export function supportHrefFor(me: MeAnswer, host: string, lang: string): string | null {
  if (!me || typeof me !== 'object') return null;
  const query = `${SUPPORT_WINDOW_PATH}?lang=${lang === 'cs' ? 'cs' : 'en'}&n=${SUPPORT_GUIDE_SLUG}`;
  if (isEdgeObject(me.edge)) {
    const central = centralUrlFromMe(me.edge.central_url);
    return central ? `${central}${query}` : null;
  }
  if (!host.includes('.')) return query;
  return `https://${host.replace(/^[^.]+\./, '')}${query}`;
}

// One read per page: the footer, the collapsed rail and the mobile menu share it. Only a
// GOOD answer is kept; a failed read (network blip, 5xx, refusal) is forgotten, so the next
// attempt (the retry below, or the next mount) asks again instead of hiding the button for
// the life of the page.
let meRead: Promise<MeAnswer> | null = null;

/** GET /user-auth/me; a refusal, a network error or a body without `username` is null. */
export function readMeOnce(fetchImpl: typeof fetch = fetch): Promise<MeAnswer> {
  if (!meRead) {
    const read: Promise<MeAnswer> = (async () => {
      try {
        const response = await fetchImpl('/user-auth/me', { credentials: 'include' });
        if (!response.ok) return null;
        const body = await response.json();
        return body && typeof body === 'object' && typeof body.username === 'string' ? body : null;
      } catch {
        return null;
      }
    })();
    meRead = read;
    void read.then((answer) => {
      if (!answer && meRead === read) meRead = null;
    });
  }
  return meRead;
}

/** Waits before the retries of a failed /me read (ms): two more tries, then the button stays hidden. */
export const ME_RETRY_DELAYS_MS = [15_000, 60_000];

/** Tests only: forget the shared read. */
export function resetSupportHrefForTests(): void {
  meRead = null;
}

/** The link of "Nahlásit problém" for this tab, or null while unknown or unavailable. */
export function useSupportHref(): string | null {
  const { i18n } = useTranslation();
  const [me, setMe] = useState<MeAnswer>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (retry: number) => {
      void readMeOnce().then((answer) => {
        if (!alive) return;
        if (answer) {
          setMe(answer);
        } else if (retry < ME_RETRY_DELAYS_MS.length) {
          timer = setTimeout(() => attempt(retry + 1), ME_RETRY_DELAYS_MS[retry]);
        }
      });
    };
    attempt(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const host = typeof window !== 'undefined' && typeof window.location?.host === 'string' ? window.location.host : '';
  return supportHrefFor(me, host, (i18n?.language || '').slice(0, 2));
}
