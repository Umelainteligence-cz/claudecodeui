import { useTranslation } from 'react-i18next';

import BrainChatMark from '@/brand/BrainChatMark';
import { BRAND_NAME, SOURCE_URL, UPSTREAM_AUTHOR, UPSTREAM_NAME, UPSTREAM_URL } from '@/brand/brandConfig';
import { BRAND_NS } from '@/brand/brandI18n';

type BrandAttributionProps = {
  /** The running CloudCLI version, from the About tab's own `useVersionCheck` (KTD9). */
  currentVersion: string;
};

const linkClass = 'break-all text-foreground underline underline-offset-2 hover:text-primary';

/**
 * The About tab's heading and attribution block (R11, KTD8, KTD9): the Brain
 * mark and "Brain Chat", then - verbatim in every locale - the LICENSE section
 * 7(b) attribution, the section 7(c) "modified version" marking and the AGPL
 * section 13 source offer. Upstream's licence line stays in the About tab.
 * UPSTREAM_AUTHOR ends in "B.V." - that full stop ends the sentence (no second one).
 */
export default function BrandAttribution({ currentVersion }: BrandAttributionProps) {
  const { t } = useTranslation(BRAND_NS);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <BrainChatMark className="h-10 w-10 rounded-xl" iconClassName="h-5 w-5" />
        <span className="text-base font-semibold text-foreground">{BRAND_NAME}</span>
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('attribution.label')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground" data-brand-attribution="">
          Based on {UPSTREAM_NAME} (
          <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {UPSTREAM_URL}
          </a>
          ), version {currentVersion}, by {UPSTREAM_AUTHOR} This is a modified version. Source code:{' '}
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={t('attribution.sourceLinkTitle')}
            className={linkClass}
          >
            {SOURCE_URL}
          </a>
          .
        </p>
      </div>
    </div>
  );
}
