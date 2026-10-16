import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic } from 'lucide-react';

import { Button, Dialog, DialogContent } from '@/shared/ui';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { VoiceInputState } from '@/shared/types';
import { VOICE_NS } from '@/modules/chat/voice/voiceI18n';
import { isVoicePlatformMode } from '@/modules/chat/voice/voiceState';

/**
 * Where a recording goes, said once before the first one (hv2, Q519 = A1).
 *
 * hv1 switches voice on by itself where the platform delivered it, so a person
 * can meet the microphone without ever having chosen voice. The first press of
 * the microphone therefore opens this question instead of the microphone;
 * Continue stores the answer (`voiceNoticeAccepted`, part of the preferences
 * blob the server keeps, so it follows the person to another browser) and starts
 * the recording from that same press. Cancel, Escape or a click outside record
 * nothing and store nothing: the next press asks again. Someone who used the
 * microphone before this existed has no answer stored and is asked once too.
 *
 * Platform mode only: the sentence names the platform relay's vendor, which is
 * not true of a self-hosted backend, and outside platform mode nothing changes.
 *
 * `shown`: the microphone is on screen and usable. When it goes away while the
 * question is open (voice withdrawn, a question panel took the composer's place)
 * the question closes as a Cancel would, so it can never reappear by itself later.
 */
export function useVoiceRecordingNotice(state: VoiceInputState, toggle: () => void, shown: boolean) {
  const { voiceNoticeAccepted } = useUiPreferences();
  const setPreference = useSetUiPreference();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  // Only a press that would START a recording asks; stopping one never does.
  const onToggle = useCallback(() => {
    if (state === 'idle' && !voiceNoticeAccepted && isVoicePlatformMode()) {
      setOpen(true);
      return;
    }
    toggle();
  }, [state, voiceNoticeAccepted, toggle]);

  const onContinue = useCallback(() => {
    setOpen(false);
    setPreference('voiceNoticeAccepted', true);
    toggle();
  }, [setPreference, toggle]);

  const onCancel = useCallback(() => setOpen(false), []);

  return { onToggle, noticeOpen: open, onContinue, onCancel };
}

type VoiceNoticeDialogProps = {
  open: boolean;
  onContinue: () => void;
  onCancel: () => void;
};

/**
 * The shared modal container, laid out as the app's confirmation dialogs are
 * (icon, sentence, Cancel then the action on the right). Cancel comes first, so
 * it is what the dialog focuses when it opens.
 */
export default function VoiceNoticeDialog({ open, onContinue, onCancel }: VoiceNoticeDialogProps) {
  const { t } = useTranslation(VOICE_NS);

  // Escape here means "not now", never "stop Claude": the chat aborts a running
  // turn on an Escape that reaches `document` (capture) without defaultPrevented,
  // and the shared Dialog closes on it without preventing the default. `window`
  // capture runs first; the Dialog still closes the question as a Cancel.
  useEffect(() => {
    if (!open) return undefined;
    const keepEscapeHere = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', keepEscapeHere, { capture: true });
    return () => window.removeEventListener('keydown', keepEscapeHere, { capture: true });
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent aria-labelledby="voice-notice-message" className="w-[calc(100vw-2rem)] max-w-md p-6">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-primary/10 p-2 text-primary">
            <Mic className="h-4 w-4" />
          </div>
          <p id="voice-notice-message" className="pt-1 text-sm text-foreground">
            {t('notice.message')}
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            {t('notice.cancel')}
          </Button>
          <Button onClick={onContinue}>
            <Mic />
            {t('notice.continue')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
