import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import BrandAttribution from '@/brand/BrandAttribution';
import { SOURCE_URL } from '@/brand/brandConfig';

/**
 * Brand overlay, KTD9: the About tab's attribution is the verbatim notice - the
 * upstream name and repository, the running version, "modified version" and the
 * AGPL section 13 source offer - with links that open outside the frame.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOTICE = (version: string) =>
  `Based on CloudCLI UI (https://github.com/siteboon/claudecodeui), version ${version}, by Siteboon AI B.V. `
  + `This is a modified version. Source code: ${SOURCE_URL}.`;

test('renders the verbatim KTD9 notice with the version it is given', () => {
  const { container } = render(<BrandAttribution currentVersion="1.37.3" />);
  const notice = container.querySelector('[data-brand-attribution]');
  expect(notice?.textContent).toBe(NOTICE('1.37.3'));
  expect(notice?.textContent).toContain('CloudCLI UI (https://github.com/siteboon/claudecodeui)');
  expect(notice?.textContent).toContain('modified version');
});

test('names the product "Brain Chat" next to the Brain mark', () => {
  const { container } = render(<BrandAttribution currentVersion="1.37.3" />);
  expect(screen.getByText('Brain Chat')).toBeTruthy();
  expect(container.querySelector('[data-brand-mark] svg')).toBeTruthy();
});

test('both links open in a new tab with rel="noopener noreferrer", and the source link is the KD5 branch', () => {
  const { container } = render(<BrandAttribution currentVersion="1.37.3" />);
  const links = [...container.querySelectorAll('[data-brand-attribution] a')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://github.com/siteboon/claudecodeui', SOURCE_URL]);
  for (const a of links) {
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  }
  // The shape only: that the branch is the PINNED version is checked by the node suite
  // (scripts/cloudcli-brand-overlay.test.js, M2), which can read the manifest and the
  // Dockerfile - neither is in the build tree.
  expect(SOURCE_URL).toMatch(/^https:\/\/github\.com\/mmmirusss\/claudecodeui\/tree\/brain-chat-v\d+\.\d+\.\d+$/);
});
