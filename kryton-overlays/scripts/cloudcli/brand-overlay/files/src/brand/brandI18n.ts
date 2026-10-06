import { i18n } from '@/modules/i18n';

import csBrand from '@/brand/locales/cs/brand.json';
import enBrand from '@/brand/locales/en/brand.json';

/**
 * The brand overlay's own `brand` namespace, registered from here and never
 * from `modules/i18n/config.ts`, which the Czech overlay owns (KTD9; the same
 * pattern as the voice overlay's `voiceI18n.ts`). Only the labels AROUND the
 * attribution are translated - the notice itself is verbatim in every locale.
 */
export const BRAND_NS = 'brand';

const bundles: Record<string, unknown> = { en: enBrand, cs: csBrand };
for (const [lng, bundle] of Object.entries(bundles)) {
  if (!i18n.hasResourceBundle(lng, BRAND_NS)) {
    i18n.addResourceBundle(lng, BRAND_NS, bundle, true, false);
  }
}

export { i18n as brandI18n };
