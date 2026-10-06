/**
 * Brain Chat brand constants for the Red Dwarf CloudCLI build (brand overlay,
 * plan "CloudCLI theme and brand", KTD8 + KTD9). Every patched upstream file
 * imports its product name from here, so the name lives in one place.
 *
 * Nothing here is translated: "Brain Chat" is a product name, and the
 * attribution notice is kept verbatim in every locale (KTD9).
 */

/** The product name CloudCLI shows wherever it names itself (KTD8). */
export const BRAND_NAME = 'Brain Chat';

/** The upstream project this build is based on (LICENSE section 7(b) attribution). */
export const UPSTREAM_NAME = 'CloudCLI UI';
export const UPSTREAM_URL = 'https://github.com/siteboon/claudecodeui';
export const UPSTREAM_AUTHOR = 'Siteboon AI B.V.';

/**
 * The AGPL section 13 source offer (KD5): a branch on our public fork carrying
 * the pinned tree with all three overlays applied, plus the overlay scripts.
 * The branch is pushed at the production step (U10) and re-pushed at every
 * re-cut; the pushed branch MUST equal this constant.
 */
export const SOURCE_URL = 'https://github.com/mmmirusss/claudecodeui/tree/brain-chat-v1.37.3';
