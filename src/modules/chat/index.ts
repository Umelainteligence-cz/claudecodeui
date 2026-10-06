export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
// Voice overlay: the auto-speak and speech-tempo rows and the platform-mode check, for Settings and Quick Settings.
export { default as AutoSpeakSetting } from '@/modules/chat/voice/AutoSpeakSetting';
export { default as VoiceRateSetting } from '@/modules/chat/voice/VoiceRateSetting';
export { VOICE_NS } from '@/modules/chat/voice/voiceI18n';
export { isVoicePlatformMode } from '@/modules/chat/voice/voiceState';
