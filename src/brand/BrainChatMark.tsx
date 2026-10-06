import { Brain } from 'lucide-react';

type BrainChatMarkProps = {
  /** Size and shape of the tile; the default is the sidebar header's. */
  className?: string;
  /** Size of the Brain glyph inside the tile. */
  iconClassName?: string;
};

/**
 * The Brain Chat mark (KTD7): lucide's Brain on the brand tile. Tile and ink
 * are the teal pair of the app's Brain Chat tab (`--brand-tile` /
 * `--brand-ink` from `palette.css`, KTD10), not `primary`, so the mark keeps
 * one hue in both modes. It links nowhere - the caller decides the wrapper.
 * Decorative: every caller sets the name "Brain Chat" right next to it.
 */
export default function BrainChatMark({
  className = 'h-7 w-7 rounded-lg',
  iconClassName = 'h-4 w-4',
}: BrainChatMarkProps) {
  return (
    <div
      className={`flex flex-shrink-0 items-center justify-center bg-[hsl(var(--brand-tile))] text-[hsl(var(--brand-ink))] shadow-sm ${className}`}
      aria-hidden="true"
      data-brand-mark=""
    >
      <Brain className={iconClassName} strokeWidth={2} />
    </div>
  );
}
