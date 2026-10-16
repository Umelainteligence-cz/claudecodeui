import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { CONTEXT_RING_NS } from '@/modules/chat/composer/contextRingI18n';
import { ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { CompactAvailability, CompactBlockedReason } from '@/shared/types';

/** Context use, from 0 to 100, at which the ring turns amber. */
const AMBER_FROM_PCT = 60;
/** Context use, from 0 to 100, at which the ring turns red. */
const RED_FROM_PCT = 85;
/** Width the confirmation asks for; it shrinks on narrow screens. */
const POPOVER_WIDTH = 288;

// Geometry of the 20px ring: the stroke sits inside the viewBox.
const RING_SIZE = 20;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** One context reading, as the ring draws it. */
type ContextUsage = {
  used: number;
  /** The denominator the arc fills against: the auto-compact limit when known, else the window. */
  limit: number;
  total: number;
  /** `used / limit` as 0-100, clamped and unrounded so the arc moves continuously. */
  pct: number;
  hasAutoCompactLimit: boolean;
};

/** The translate function, narrowed to what the formatter needs. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Reads the context reading out of a session's token budget, or null when the
 * budget cannot draw a truthful ring. Its guard is stricter than the token
 * pill's on purpose: no `Number()` coercion and no `input + output` fallback,
 * because a guessed number would show a wrong percentage rather than the pill.
 */
export function readContextUsage(tokenBudget: Record<string, unknown> | null | undefined): ContextUsage | null {
  if (!tokenBudget) return null;
  const { used, total, autoCompactLimit } = tokenBudget;
  if (!isFiniteNumber(used) || !isFiniteNumber(total) || total <= 0) return null;

  const hasAutoCompactLimit = isFiniteNumber(autoCompactLimit) && autoCompactLimit > 0;
  const limit = hasAutoCompactLimit ? autoCompactLimit : total;
  const pct = Math.min(100, Math.max(0, (used / limit) * 100));
  return { used, limit, total, pct, hasAutoCompactLimit };
}

/**
 * Thousands of tokens: whole above 10K, one decimal below, so small counts do
 * not read as 0K. The decimal separator follows the language (cs "1,5K").
 */
function formatThousands(tokens: number, language: string): string {
  const thousands = Math.max(0, tokens) / 1000;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  try {
    return new Intl.NumberFormat(language, { maximumFractionDigits: 1, useGrouping: false }).format(rounded);
  } catch {
    // A language tag Intl rejects still gets a readable number.
    return String(rounded);
  }
}

/**
 * The usage lines the tooltip and the confirmation both show: used against the
 * arc's own denominator, the full window on its own line when that differs, and
 * what remains - judged on the same rounded number the label shows.
 */
export function formatContextTooltip(usage: ContextUsage, t: Translate, language: string): string[] {
  const remaining = 100 - Math.round(usage.pct);
  const used = formatThousands(usage.used, language);
  if (usage.hasAutoCompactLimit) {
    return [
      t('usage.used', { used, limit: formatThousands(usage.limit, language) }),
      t('usage.ofWindow', { total: formatThousands(usage.total, language) }),
      t('usage.remainingUntilAuto', { pct: remaining }),
    ];
  }
  return [
    t('usage.usedOfTotal', { used, total: formatThousands(usage.total, language) }),
    t('usage.remaining', { pct: remaining }),
  ];
}

/** Arc colour for the shown percentage; Tailwind palette classes that read in both themes. */
function ringToneClass(shownPct: number): string {
  if (shownPct >= RED_FROM_PCT) return 'text-red-500 dark:text-red-400';
  if (shownPct >= AMBER_FROM_PCT) return 'text-amber-500 dark:text-amber-400';
  return 'text-emerald-500 dark:text-emerald-400';
}

/**
 * Keeps Enter and Space on the confirmation's buttons inside it. The popover is
 * portalled, but React still bubbles its events through the component tree,
 * so without this the composer form's key handlers would see them.
 */
function keepActivationKeysInside(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

type ContextUsageRingProps = {
  used: number;
  limit: number;
  total: number;
  pct: number;
  hasAutoCompactLimit: boolean;
  isCompacting: boolean;
  canCompact: boolean;
  blockedReason: CompactBlockedReason | null;
  /** The session the composer is bound to; a change closes the confirmation. */
  sessionKey: string | null;
  onCompact: () => void;
  onShowTokenUsage: () => void;
};

/**
 * The ring itself plus its compact confirmation. Takes primitives so `memo`
 * holds while the composer re-renders on every keystroke.
 */
const ContextUsageRing = memo(function ContextUsageRing({
  used,
  limit,
  total,
  pct,
  hasAutoCompactLimit,
  isCompacting,
  canCompact,
  blockedReason,
  sessionKey,
  onCompact,
  onShowTokenUsage,
}: ContextUsageRingProps) {
  const { t, i18n } = useTranslation(CONTEXT_RING_NS);
  const language = i18n.language;
  // Whether the compact confirmation is showing. Opened by the ring, closed by
  // every way out the confirmation offers and by a session switch.
  const [isOpen, setIsOpen] = useState(false);
  // Stable, or the anchor hook's listener effect would re-run on every render.
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, POPOVER_WIDTH, 'start');
  const titleId = useId();
  const bodyId = useId();
  const reasonId = useId();

  // The session this render belongs to. A confirmation opened for one session
  // must not compact another, so a change closes it - adjusted during render,
  // the way React recommends, rather than one frame late from an effect.
  const [renderedSessionKey, setRenderedSessionKey] = useState(sessionKey);
  if (renderedSessionKey !== sessionKey) {
    setRenderedSessionKey(sessionKey);
    setIsOpen(false);
  }

  const shownPct = Math.round(pct);
  const lines = useMemo(
    () => formatContextTooltip({ used, limit, total, pct, hasAutoCompactLimit }, t, language),
    [used, limit, total, pct, hasAutoCompactLimit, t, language],
  );
  // The hook keeps compacting out of `canCompact` already (a running turn is
  // `busy`); this keeps the dialog honest even if a caller passes otherwise.
  const shownReason = blockedReason ?? (isCompacting ? 'busy' : null);
  const isCompactDisabled = !canCompact || isCompacting;
  const label = isCompacting ? t('ring.compacting') : t('ring.ariaLabel', { pct: shownPct });

  const closeAndRefocus = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const usageLines = (
    <>
      {lines.map((line) => (
        <span key={line} className="block">{line}</span>
      ))}
    </>
  );

  return (
    <>
      {/* Hidden by class while the dialog is open: clearing `content` would make
          the Tooltip swap its wrapper for a fragment, remount the button and
          lose its focus. */}
      <Tooltip
        content={<span data-slot="context-ring-tooltip">{usageLines}</span>}
        className={isOpen ? 'hidden' : undefined}
      >
        <PromptInputButton
          ref={triggerRef}
          onClick={() => {
            updateAnchor();
            setIsOpen((current) => !current);
          }}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-busy={isCompacting}
          className={cn('shrink-0', isCompacting && 'motion-safe:animate-pulse')}
        >
          <svg
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            width={RING_SIZE}
            height={RING_SIZE}
            aria-hidden="true"
            focusable="false"
            className="-rotate-90"
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              strokeOpacity={0.2}
              className="text-muted-foreground"
            />
            {/* Left out at 0 %: a zero-length round-capped stroke still paints a dot. */}
            {pct > 0 && (
              <circle
                data-slot="context-ring-arc"
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
                className={ringToneClass(shownPct)}
              />
            )}
          </svg>
        </PromptInputButton>
      </Tooltip>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface
          anchor={anchor}
          menuRef={menuRef}
          role="dialog"
          ariaModal={false}
          ariaLabelledBy={titleId}
          ariaDescribedBy={shownReason ? `${bodyId} ${reasonId}` : bodyId}
        >
          {/* Only Enter and Space are stopped; Escape is handled in the capture phase by the anchor hook. */}
          <div className="space-y-2 p-2 text-sm" onKeyDown={keepActivationKeysInside}>
            <div className="text-xs text-muted-foreground">{usageLines}</div>
            <p id={titleId} className="font-medium text-foreground">{t('confirm.title')}</p>
            <p id={bodyId} className="text-xs text-muted-foreground">{t('confirm.body')}</p>
            {shownReason && (
              <p id={reasonId} className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {t(`blocked.${shownReason}`)}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  onShowTokenUsage();
                  setIsOpen(false);
                }}
                className="mr-auto rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('confirm.details')}
              </button>
              <button
                type="button"
                // Focus starts here so a second Enter after opening cancels rather than compacts.
                autoFocus
                onClick={closeAndRefocus}
                className="rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('confirm.cancel')}
              </button>
              <button
                type="button"
                disabled={isCompactDisabled}
                onClick={() => {
                  onCompact();
                  closeAndRefocus();
                }}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('confirm.compact')}
              </button>
            </div>
          </div>
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
});

type ContextRingSlotProps = {
  provider?: string;
  tokenBudget: Record<string, unknown> | null;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactAvailability?: CompactAvailability;
  compactSessionKey?: string | null;
  onShowTokenUsage: () => void;
  /** The token pill, rendered unchanged whenever the ring is not. */
  fallback: ReactNode;
};

/**
 * Rendered by chat's ChatComposer in the token pill's place: shows the context
 * ring for Claude sessions with a usable reading while the `showContextRing`
 * preference is on, and the pill exactly as before otherwise.
 */
export const ContextRingSlot = memo(function ContextRingSlot({
  provider,
  tokenBudget,
  onCompact,
  isCompacting = false,
  compactAvailability,
  compactSessionKey = null,
  onShowTokenUsage,
  fallback,
}: ContextRingSlotProps) {
  const { t } = useTranslation(CONTEXT_RING_NS);
  const { showContextRing } = useUiPreferences();
  const usage = useMemo(() => readContextUsage(tokenBudget), [tokenBudget]);
  const showRing = Boolean(
    showContextRing && provider === 'claude' && usage && onCompact && compactAvailability,
  );

  // What the polite status region last said. Lives here, not in the ring, so
  // the end of a compact is still announced when a null budget hides the ring.
  const [announcement, setAnnouncement] = useState('');
  const wasCompactingRef = useRef(isCompacting);
  const announcedSessionKeyRef = useRef(compactSessionKey);
  const blockedReason = compactAvailability?.blockedReason ?? null;
  useEffect(() => {
    // The composer outlives a session switch, so leaving or returning to a
    // running compact flips `isCompacting` too; that is not a start or an end.
    const sessionChanged = announcedSessionKeyRef.current !== compactSessionKey;
    announcedSessionKeyRef.current = compactSessionKey;
    if (wasCompactingRef.current === isCompacting) return;
    wasCompactingRef.current = isCompacting;
    // A dropped connection ends the pulse without the compact having finished.
    const silent = sessionChanged || (!isCompacting && blockedReason === 'offline');
    setAnnouncement(silent ? '' : t(isCompacting ? 'status.started' : 'status.finished'));
  }, [blockedReason, compactSessionKey, isCompacting, t]);

  // Mounted only once there is something to announce, so a composer without a
  // ring renders exactly the pill's markup.
  const showStatus = showRing || isCompacting || announcement !== '';

  return (
    <>
      {showRing && usage && onCompact && compactAvailability ? (
        <ContextUsageRing
          used={usage.used}
          limit={usage.limit}
          total={usage.total}
          pct={usage.pct}
          hasAutoCompactLimit={usage.hasAutoCompactLimit}
          isCompacting={isCompacting}
          canCompact={compactAvailability.canCompact}
          blockedReason={compactAvailability.blockedReason}
          sessionKey={compactSessionKey}
          onCompact={onCompact}
          onShowTokenUsage={onShowTokenUsage}
        />
      ) : (
        fallback
      )}
      {showStatus && (
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      )}
    </>
  );
});
