import { i18n } from '@/modules/i18n';

import csPdf from '@/modules/chat/export/locales/cs/pdfExport.json';
import enPdf from '@/modules/chat/export/locales/en/pdfExport.json';

/**
 * Kryton PDF overlay (E474): the "PDF (print)" texts live in the `chat` namespace, because the
 * export menu translates every item with `t(format.labelKey)` there. They are merged in from
 * here (deep, never overwriting), not written into the Czech overlay's `locale-cs/chat.json`:
 * that overlay is temporary and pins its key counts, and this one must keep its texts when it
 * goes. The same pattern as the voice and brand overlays' own bundles.
 */
export const PDF_EXPORT_NS = 'chat';

const bundles: Record<string, Record<string, unknown>> = { en: enPdf, cs: csPdf };
for (const [lng, bundle] of Object.entries(bundles)) {
  i18n.addResourceBundle(lng, PDF_EXPORT_NS, bundle, true, false);
}

export { i18n as pdfExportI18n };
