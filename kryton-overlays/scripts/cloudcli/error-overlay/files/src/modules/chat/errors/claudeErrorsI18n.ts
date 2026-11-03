import { i18n } from '@/modules/i18n';

import csClaudeErrors from '@/modules/chat/errors/locales/cs/claudeErrors.json';
import enClaudeErrors from '@/modules/chat/errors/locales/en/claudeErrors.json';

/** The overlay's own namespace, registered here so it needs no anchor in the i18n module. */
export const CLAUDE_ERRORS_NS = 'claudeErrors';

const bundles: Record<string, unknown> = { en: enClaudeErrors, cs: csClaudeErrors };
for (const [lng, bundle] of Object.entries(bundles)) {
  if (!i18n.hasResourceBundle(lng, CLAUDE_ERRORS_NS)) {
    i18n.addResourceBundle(lng, CLAUDE_ERRORS_NS, bundle, true, false);
  }
}
