/**
 * One error contract for the three voice hops (browser → CloudCLI relay →
 * voice service). The service answers with a status the relay keeps and a body
 * carrying `{code}` from a closed set; the relay forwards that body as `error`.
 * The client maps each code to plain copy and never shows a status code, a
 * vendor message or a raw body.
 */

export const SERVICE_ERROR_CODES = [
  'cap_daily',
  'cap_rate',
  'cap_request',
  'cap_concurrency',
  'vendor_rate',
  'vendor_down',
  'timeout',
  'unknown_workspace',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
/** Client-side classes on top of the service's own codes. */
export type VoiceErrorCode = ServiceErrorCode | 'network' | 'generic';

const KNOWN = new Set<string>(SERVICE_ERROR_CODES);

/** Finds the service's `code` in a body the relay may have wrapped once or twice. */
export function parseServiceErrorCode(body: string | null | undefined): ServiceErrorCode | null {
  const text = String(body || '');
  const quoted = /"code"\s*:\s*"([a-z_]+)"/.exec(text) || /\\"code\\"\s*:\s*\\"([a-z_]+)\\"/.exec(text);
  if (quoted && KNOWN.has(quoted[1])) return quoted[1] as ServiceErrorCode;
  return null;
}

/** Maps a failed voice response to an error code. */
export function voiceErrorFromResponse(status: number, body: string | null | undefined): VoiceErrorCode {
  const code = parseServiceErrorCode(body);
  if (code) return code;
  if (status === 504 || status === 408) return 'timeout';
  if (status === 429) return 'vendor_rate';
  if (status === 502 || status === 503) return 'vendor_down';
  return 'generic';
}

/** Maps a thrown fetch error to an error code. */
export function voiceErrorFromException(error: unknown): VoiceErrorCode {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (name === 'TypeError') return 'network';
  if (error instanceof VoiceRequestError) return error.code;
  return 'generic';
}

export class VoiceRequestError extends Error {
  readonly code: VoiceErrorCode;
  constructor(code: VoiceErrorCode) {
    super(code);
    this.name = 'VoiceRequestError';
    this.code = code;
  }
}

/** Translation key (namespace `voice`) for an error code. */
export const voiceErrorKey = (code: VoiceErrorCode | string): string =>
  KNOWN.has(code) || code === 'network' || code === 'generic' ? `errors.${code}` : 'errors.generic';

/** Classes of microphone failure the builder must be told apart. */
export type MicErrorClass = 'policyBlocked' | 'embeddedBrowser' | 'deniedIos' | 'denied' | 'busy' | 'notFound' | 'generic';

type PolicyDocument = Document & {
  permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
  featurePolicy?: { allowsFeature?: (feature: string) => boolean };
};

type IosNavigator = Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & {
  standalone?: boolean;
  mediaDevices?: unknown;
};

/** `safari` = Safari or a view that looks exactly like it; `embedded` = another app's browser; `other` = a named browser or a home-screen app. */
export type IosBrowserKind = 'safari' | 'embedded' | 'other';

const IOS_OTHER_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|Brave/;
const IOS_APP_TOKEN = /FBAN|FBAV|FB_IAB|Instagram|Line\/|GSA\/|Twitter|LinkedInApp|Snapchat|MicroMessenger|Teams\/|Outlook/;

/**
 * Which iPhone/iPad browser this is, or `null` off iOS. An app's own browser
 * (the bar with back / share / reload / compass) cannot be told from Safari by
 * its user agent when it is a Safari view, so `safari` also covers that case -
 * the copy for it names both ways out.
 */
export function iosBrowserKind(nav: IosNavigator | undefined = globalThis.navigator): IosBrowserKind | null {
  const ua = nav?.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  if (!ios) return null;
  if (nav?.standalone === true || IOS_OTHER_BROWSER.test(ua)) return 'other';
  if (/\bVersion\/[\d.]+/.test(ua) && /\bSafari\//.test(ua) && !IOS_APP_TOKEN.test(ua)) return 'safari';
  return 'embedded';
}

/**
 * A permissions-policy block and a builder's own "Block" both surface as
 * `NotAllowedError`; the document's policy tells them apart. On an iPhone the
 * lock icon does not exist and an app-embedded browser never opens the
 * microphone at all, so those two get their own class.
 */
export function classifyMicError(
  error: unknown,
  doc: Document | undefined = globalThis.document,
  nav: IosNavigator | undefined = globalThis.navigator,
): MicErrorClass {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const policy = (doc as PolicyDocument | undefined)?.permissionsPolicy ?? (doc as PolicyDocument | undefined)?.featurePolicy;
    try {
      if (policy?.allowsFeature && policy.allowsFeature('microphone') === false) return 'policyBlocked';
    } catch {
      /* the policy API is best effort */
    }
    const ios = iosBrowserKind(nav);
    if (ios === 'embedded') return 'embeddedBrowser';
    if (ios === 'safari') return 'deniedIos';
    return 'denied';
  }
  // No `navigator.mediaDevices` throws a TypeError before any permission is asked.
  if (name === 'TypeError' && !nav?.mediaDevices) {
    const ios = iosBrowserKind(nav);
    if (ios === 'embedded' || ios === 'safari') return 'embeddedBrowser';
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'busy';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'notFound';
  return 'generic';
}

export const micErrorKey = (kind: MicErrorClass): string =>
  kind === 'generic' ? 'errors.generic' : `dictation.${kind}`;

/** How long the red strip stays: the two iPhone instructions are long enough to need more than the 4 s of a short refusal. */
export const micErrorHoldMs = (key: string): number =>
  key === 'dictation.embeddedBrowser' || key === 'dictation.deniedIos' ? 12000 : 4000;
