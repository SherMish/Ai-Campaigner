// AIC-139: one ad's full creative, for the details modal.
//
// Separate from ad-media.ts, which answers "what pictures does this ad have"
// for the whole campaign at once. This answers "show me EVERYTHING about this
// one ad" and is fetched only when a customer opens it — the panel already
// makes two live Meta reads on open, and adding the copy of every ad to that
// would pay for text nobody has asked to see yet.
//
// EVERY FIELD HERE IS ALSO WHAT AN EDIT WOULD NEED. Meta ad creatives are
// immutable — its own reference lists `name` and `status` as the only editable
// fields — so changing an ad's copy means building a new creative from exactly
// these values with the edits applied. Reading them in the shape the builder
// writes them keeps that door open without pretending it is already built.

export interface AdDetail {
  adId: string;
  name: string | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  // The headline: the small bold line UNDER the picture, next to the button.
  headline: string | null;
  // The primary text: the paragraph ABOVE the picture.
  primaryText: string | null;
  imageUrl: string | null;
  ctaType: string | null;
  // Where the button actually goes. Null on a creative built from an existing
  // post, whose destination is the post's own.
  whatsappNumber: string | null;
  link: string | null;
  // An ad built from an existing Page post carries no copy of ours — the post
  // IS the creative. The UI must say that rather than render three blanks.
  fromExistingPost: boolean;
}

export interface AdDetailReader {
  getAdDetail(metaAdId: string): Promise<AdDetail | null>;
}

export interface RawAdDetail {
  id: string;
  name?: string | null;
  effective_status?: string | null;
  creative?: {
    id?: string;
    title?: string | null;
    body?: string | null;
    image_url?: string | null;
    object_story_id?: string | null;
    object_story_spec?: {
      link_data?: {
        message?: string | null;
        name?: string | null;
        link?: string | null;
        call_to_action?: { type?: string | null; value?: { whatsapp_number?: string | null; link?: string | null } | null } | null;
      } | null;
    } | null;
    call_to_action_type?: string | null;
  } | null;
}

export function normalizeAdDetail(row: RawAdDetail): AdDetail {
  const c = row.creative ?? {};
  const link = c.object_story_spec?.link_data ?? null;
  const cta = link?.call_to_action ?? null;
  return {
    adId: String(row.id),
    name: row.name ?? null,
    effectiveStatus: row.effective_status ?? null,
    creativeId: c.id ?? null,
    // Prefer link_data, which is what we WROTE; `title`/`body` are Meta's
    // derived copies of the same values and can be absent on some shapes.
    headline: link?.name ?? c.title ?? null,
    primaryText: link?.message ?? c.body ?? null,
    imageUrl: c.image_url ?? null,
    ctaType: cta?.type ?? c.call_to_action_type ?? null,
    whatsappNumber: cta?.value?.whatsapp_number ?? null,
    link: cta?.value?.link ?? link?.link ?? null,
    // object_story_id means the creative points at a real Page post rather
    // than carrying its own link_data.
    fromExistingPost: !!c.object_story_id,
  };
}
