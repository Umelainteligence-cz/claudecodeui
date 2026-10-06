import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import AboutTab from '@/modules/settings/tabs/AboutTab';

/**
 * Brand overlay, KTD8 + KTD9 against the PATCHED upstream AboutTab: the heading
 * is Brain Chat with the attribution, the version in the notice is the one
 * `useVersionCheck` reports, and upstream's licence line (AGPL "Appropriate
 * Legal Notices") survives the patch.
 */

vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: '9.8.7',
    releaseInfo: null,
    installMode: 'npm',
  }),
}));

test('the About tab shows Brain Chat, the notice with the hook version, and keeps the licence line', () => {
  const { container } = render(<AboutTab />);
  const text = container.textContent ?? '';
  expect(text).toContain('Brain Chat');
  expect(container.querySelector('[data-brand-attribution]')?.textContent).toContain('version 9.8.7, by Siteboon AI B.V.');
  // `about.licensed` - "Licensed under AGPL-3.0" in the default (English) locale.
  expect(text).toContain('Licensed under AGPL-3.0');
  // The old wordmark heading is gone; the project links stay (allow-listed, KTD8).
  expect(container.querySelector('a[href="https://cloudcli.ai"]')).toBeTruthy();
});
