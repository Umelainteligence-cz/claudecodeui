import { useTranslation } from 'react-i18next';

import { claudeErrorCard } from '@/modules/chat/errors/claudeErrorCard';
import { CLAUDE_ERRORS_NS } from '@/modules/chat/errors/claudeErrorsI18n';

type ClaudeErrorCardProps = {
  code: string;
  content: string;
};

/** Says what happened and what to do in the reader's language; the original stays reachable. */
export default function ClaudeErrorCard({ code, content }: ClaudeErrorCardProps) {
  const { t } = useTranslation(CLAUDE_ERRORS_NS);
  const showOriginal = claudeErrorCard(code)?.showOriginal;

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center space-x-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
          !
        </div>
        <div className="text-sm font-medium text-gray-900 dark:text-white">{t(`${code}.title`)}</div>
      </div>
      <div className="text-sm text-gray-700 dark:text-gray-300">{t(`${code}.action`)}</div>
      {showOriginal ? (
        <div className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{content}</div>
      ) : (
        <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer">{t('details')}</summary>
          <div className="mt-1 whitespace-pre-wrap">{content}</div>
        </details>
      )}
    </div>
  );
}
