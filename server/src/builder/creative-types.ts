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
  id: string; // unprefixed post id
  message: string | null;
  pictureUrl: string | null;
  createdAt: string;
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
  media: CreativeMedia;
  // Same contract as CreateAdSetParams.destination — resolved via
  // resolveDestinationShape, never assumed inside the adapter.
  destination: string;
}

export interface CreatePostCreativeParams {
  adAccountId: string;
  pageId: string;
  name: string;
  postId: string; // an id from listPromotablePosts
}

export interface CreativeWriter {
  uploadImage(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedImage>;
  // Uploads and waits (bounded) for Meta to finish processing so a thumbnail
  // is available — a video creative can't be created without one.
  uploadVideo(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedVideo>;
  listPromotablePosts(pageId: string): Promise<PromotablePost[]>;
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
