// Creative-handling write/read shapes (AIC-51) — turning a customer's media
// (an upload, or an existing IG/FB post) into a Meta ad creative createAd
// (AIC-50) can attach. Kept as its own interface, same pattern as
// BuilderWriter (types.ts): implemented by GraphCampaignAdapter alongside
// its other roles, not folded into an unrelated interface.

export interface UploadedImage {
  hash: string; // Meta's image hash — what an ad creative references
  url: string;
}

export interface UploadedVideo {
  videoId: string;
  thumbnailUrl: string; // Meta requires a thumbnail on a video creative; auto-generated once processing finishes
}

export interface PromotablePost {
  id: string; // unprefixed post id (Facebook) / IG media id (Instagram)
  message: string | null;
  pictureUrl: string | null;
  createdAt: string;
  /**
   * AIC-156 — WHICH network this content came from. The two are promoted by
   * genuinely different Meta calls (`object_story_id` vs `object_id` +
   * `source_instagram_media_id`), so this is not a label: it selects the
   * creative shape. Defaulting it would mean silently building the wrong one.
   */
  source: "facebook" | "instagram";
  /**
   * Instagram only. Meta refuses to boost media with licensed music or
   * interactive filters, and says so up front via `boost_eligibility_info`.
   * `false` means the picker shows it disabled with the reason rather than
   * hiding it — the AIC-98 rule: a short list reads as "you have no posts",
   * which is false and sends the customer down the wrong path.
   */
  boostable?: boolean;
  boostReason?: string | null;
}

export type CreativeMedia =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videoId: string; thumbnailUrl: string };

export interface CreateUploadCreativeParams {
  adAccountId: string;
  pageId: string;
  name: string;
  headline: string;
  primaryText: string;
  whatsappNumber: string;
  // AIC-102: the website/Pixel destination's counterpart to whatsappNumber —
  // set only when destination resolves to the WEBSITE shape, used for both
  // link_data.link and the LEARN_MORE call_to_action's value.
  destinationUrl?: string;
  media: CreativeMedia;
  // Same contract as CreateAdSetParams.destination — resolved via
  // resolveDestinationShape, never assumed inside the adapter.
  destination: string;
  /**
   * AIC-156 — the customer's own Instagram account (`meta_connections.
   * instagram_id`), so the ad runs on Instagram AS THEM.
   *
   * Omitted, Meta does not stop serving Instagram placements — it serves them
   * under the PAGE-BACKED Instagram account, the shadow profile it
   * auto-creates, which has no username and which nobody logs into. That is
   * the same object `listInstagramAccounts` deliberately refuses to OFFER as a
   * choice (campaign-adapter.ts), because an unidentifiable id in front of an
   * operator is worse than nothing. Meta will happily USE it when we stay
   * silent — so a customer connected their Instagram and their ads ran as
   * somebody else.
   *
   * Optional because a connection legitimately may not have one.
   */
  instagramUserId?: string | null;
}

export interface CreatePostCreativeParams {
  adAccountId: string;
  pageId: string;
  name: string;
  postId: string; // an id from listPromotablePosts
  /**
   * AIC-156. "facebook" promotes a Page post via `object_story_id`;
   * "instagram" promotes IG media via `object_id` (the Page) plus
   * `source_instagram_media_id`. Two different Meta payloads, so the caller
   * must say which — there is no safe default.
   */
  postSource?: "facebook" | "instagram";
  // Found live 2026-08-23: without a CTA this creative cannot serve a
  // click-to-WhatsApp (or website) objective, and Meta refuses the AD with
  // "The ad's creative is incompatible with the objective of the campaign".
  // Optional so existing callers are unchanged — omitted means "post as is",
  // which is right for engagement and was the only behaviour before.
  destination?: string;
  whatsappNumber?: string; // whatsapp destinations
  destinationUrl?: string; // website destinations
  /**
   * AIC-156 — the customer's own Instagram account (`meta_connections.
   * instagram_id`), so the ad runs on Instagram AS THEM.
   *
   * Omitted, Meta does not stop serving Instagram placements — it serves them
   * under the PAGE-BACKED Instagram account, the shadow profile it
   * auto-creates, which has no username and which nobody logs into. That is
   * the same object `listInstagramAccounts` deliberately refuses to OFFER as a
   * choice (campaign-adapter.ts), because an unidentifiable id in front of an
   * operator is worse than nothing. Meta will happily USE it when we stay
   * silent — so a customer connected their Instagram and their ads ran as
   * somebody else.
   *
   * Optional because a connection legitimately may not have one.
   */
  instagramUserId?: string | null;
}

export interface CreativeWriter {
  uploadImage(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedImage>;
  // Uploads and waits (bounded) for Meta to finish processing so a thumbnail
  // is available — a video creative can't be created without one.
  uploadVideo(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedVideo>;
  listPromotablePosts(pageId: string): Promise<PromotablePost[]>;
  // AIC-156 — the customer's own Instagram posts, the other half of "promote
  // something I already published". Separate from the Page edge because they
  // are separate Meta objects promoted by separate calls; merged for display
  // in builder/promotable-content.ts.
  listInstagramMedia(igUserId: string): Promise<PromotablePost[]>;
  createCreativeFromUpload(params: CreateUploadCreativeParams): Promise<string>; // → new creative id
  createCreativeFromExistingPost(params: CreatePostCreativeParams): Promise<string>; // → new creative id
}

// Deterministic fake for tests — no real upload/network, just records calls
// and hands back stable ids.
export class FakeCreativeWriter implements CreativeWriter {
  public imageUploads: Array<{ adAccountId: string; filename: string }> = [];
  public videoUploads: Array<{ adAccountId: string; filename: string }> = [];
  public uploadCreativeCalls: CreateUploadCreativeParams[] = [];
  public postCreativeCalls: CreatePostCreativeParams[] = [];
  public promotablePosts: PromotablePost[] = [];
  public instagramMedia: PromotablePost[] = [];
  public failNextCreateFromUpload = 0;
  private counter = 0;

  async uploadImage(adAccountId: string, _fileBuffer: Buffer, filename: string): Promise<UploadedImage> {
    this.imageUploads.push({ adAccountId, filename });
    return { hash: `hash_${++this.counter}`, url: `https://fake/${filename}` };
  }
  async uploadVideo(adAccountId: string, _fileBuffer: Buffer, filename: string): Promise<UploadedVideo> {
    this.videoUploads.push({ adAccountId, filename });
    return { videoId: `vid_${++this.counter}`, thumbnailUrl: `https://fake/${filename}.jpg` };
  }
  async listPromotablePosts(_pageId: string): Promise<PromotablePost[]> {
    return this.promotablePosts;
  }
  async listInstagramMedia(_igUserId: string): Promise<PromotablePost[]> {
    return this.instagramMedia;
  }
  async createCreativeFromUpload(params: CreateUploadCreativeParams): Promise<string> {
    if (this.failNextCreateFromUpload > 0) {
      this.failNextCreateFromUpload--;
      throw new Error("simulated Meta create-creative failure");
    }
    this.uploadCreativeCalls.push(params);
    return `crea_${++this.counter}`;
  }
  async createCreativeFromExistingPost(params: CreatePostCreativeParams): Promise<string> {
    this.postCreativeCalls.push(params);
    return `crea_${++this.counter}`;
  }
}
