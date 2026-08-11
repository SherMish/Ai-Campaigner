// Creative handling (AIC-51) — the content step of the builder: get the
// customer's creative into Meta as an ad creative createAd (AIC-50) can
// attach. Two paths (both real customers have): upload new media, or pick an
// existing IG/FB post (like GelNails did). This module holds the
// PLATFORM-INDEPENDENT, COPY-FREE pieces (validation logic, limits) — the
// Meta API calls live in server/src/builder/; the actual Hebrew displayed to
// the customer (the PRD §8 responsibility notice, per-error message text)
// lives in web/src/strings.ts per CLAUDE.md, keyed off the error codes below.

export const RECOMMENDED_AD_COUNT = { min: 3, max: 5 } as const;

// Meta's own hard cap on an upload — this is well past what a small business
// creative needs, so it's a sanity ceiling, not a real-world constraint.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB — "short video," not a resumable-upload-scale file

// Soft length guards: Meta doesn't hard-reject on length (text may just get
// cropped in some placements), so these catch the obvious "forgot to write
// anything" / "pasted three paragraphs" cases, not a precise platform limit.
export const HEADLINE_MAX_CHARS = 60;
export const PRIMARY_TEXT_MAX_CHARS = 400;

export interface CreativeCopyInput {
  headline: string;
  primaryText: string;
  hasMedia: boolean; // an uploaded image/video OR an existing post was selected
}

// One code per distinct problem — never display text. web/src/strings.ts maps
// each code to its Hebrew message (and interpolates the *_MAX_CHARS limits
// above where needed); the server returns codes over the API untranslated.
export type CreativeValidationErrorCode =
  | "missing_media"
  | "missing_headline"
  | "headline_too_long"
  | "missing_primary_text"
  | "primary_text_too_long";

export interface CreativeValidationResult {
  valid: boolean;
  errors: CreativeValidationErrorCode[];
}

// Pre-create validity checks (AIC-51) — catch the obvious rejection causes
// before Meta review, not after. Deliberately permissive on content itself
// (we don't judge claims/accuracy — that's the customer's responsibility,
// PRD §8); this only catches "nothing was actually provided."
export function validateCreativeCopy(input: CreativeCopyInput): CreativeValidationResult {
  const errors: CreativeValidationErrorCode[] = [];
  if (!input.hasMedia) errors.push("missing_media");
  if (!input.headline.trim()) errors.push("missing_headline");
  else if (input.headline.length > HEADLINE_MAX_CHARS) errors.push("headline_too_long");
  if (!input.primaryText.trim()) errors.push("missing_primary_text");
  else if (input.primaryText.length > PRIMARY_TEXT_MAX_CHARS) errors.push("primary_text_too_long");
  return { valid: errors.length === 0, errors };
}
