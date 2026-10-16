import { i18n } from '@/modules/i18n';

import csContextRing from '@/modules/chat/composer/locales/cs/contextRing.json';
import enContextRing from '@/modules/chat/composer/locales/en/contextRing.json';

/**
 * The context ring overlay's own `contextRing` namespace, registered from here
 * rather than from `modules/i18n/config.ts`: the overlay then needs no anchor in
 * the file the Czech overlay also patches, and removing either overlay cannot
 * take the other's strings with it. Every overlay component imports this module
 * (or one that does) before calling `useTranslation(CONTEXT_RING_NS)`.
 */
export const CONTEXT_RING_NS = 'contextRing';

const bundles: Record<string, unknown> = { en: enContextRing, cs: csContextRing };
for (const [lng, bundle] of Object.entries(bundles)) {
  if (!i18n.hasResourceBundle(lng, CONTEXT_RING_NS)) {
    i18n.addResourceBundle(lng, CONTEXT_RING_NS, bundle, true, false);
  }
}

export { i18n as contextRingI18n };
