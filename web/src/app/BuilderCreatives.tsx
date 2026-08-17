import { useState } from "react";
import { strings, creativeValidationMessage } from "../strings";
import {
  getPromotablePosts, uploadCreativeFile, createCreative, CreativeValidationError, ApiError,
  type PromotablePost, type UploadedMedia, type CreateCreativeBody,
} from "../api";
import { StatusPill } from "./components";

const b = strings.he.builder;
const c = b.creatives;

export interface AdDraft {
  clientKey: string;
  name: string;
  source: "upload" | "post";
  headline: string;
  primaryText: string;
  media: UploadedMedia | null;
  postId: string | null;
  postPreview: string | null;
  creativeId: string | null;
  status: "draft" | "uploading" | "creating" | "created" | "error";
  error: string | null;
}

export function newAdDraft(index: number): AdDraft {
  return {
    clientKey: `adset-1-ad-${index}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${c.adTitle} ${index}`,
    source: "upload",
    headline: "",
    primaryText: "",
    media: null,
    postId: null,
    postPreview: null,
    creativeId: null,
    status: "draft",
    error: null,
  };
}

// The minimal creative-creation shape, without localCampaignId — the builder
// resolves that from a prop closure (see below); AIC-63's add-content screen
// resolves it server-side from the caller's context instead, so it's never
// part of this shared shape.
export type AdCreativeBody =
  | {
      clientKey: string; name: string; headline: string; primaryText: string;
      whatsappNumber?: string; destination?: string; destinationUrl?: string;
      media: UploadedMedia;
    }
  | { clientKey: string; name: string; postId: string };

interface Props {
  ads: AdDraft[];
  onChange: (ads: AdDraft[]) => void;
  // Only used by the default createCreativeFn (the builder's own endpoint) —
  // omit when passing a custom createCreativeFn (AIC-63's screen resolves
  // its campaign server-side instead).
  localCampaignId?: string;
  // AIC-89: both optional now — a website-destination build passes
  // destination/destinationUrl instead of whatsappNumber. AddContent.tsx
  // (AIC-63) passes neither; the additions server infers the destination
  // from the existing campaign's own configuration.
  whatsappNumber?: string;
  destination?: string;
  destinationUrl?: string;
  // AIC-63: injectable so AddContent.tsx can point creative creation at
  // /app/additions/* instead of /app/builder/* — same component and UI,
  // different backend routes. Defaults to the builder's own endpoints.
  getPosts?: () => Promise<{ posts: PromotablePost[] }>;
  uploadFile?: (file: File) => Promise<UploadedMedia>;
  createCreativeFn?: (body: AdCreativeBody) => Promise<{ creativeId: string }>;
}

export function BuilderCreatives({
  ads, onChange, localCampaignId, whatsappNumber, destination, destinationUrl,
  getPosts = getPromotablePosts,
  uploadFile = uploadCreativeFile,
  createCreativeFn = (body) => createCreative({ ...body, localCampaignId } as CreateCreativeBody),
}: Props) {
  const [posts, setPosts] = useState<PromotablePost[] | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);

  function update(key: string, patch: Partial<AdDraft>) {
    onChange(ads.map((a) => (a.clientKey === key ? { ...a, ...patch } : a)));
  }

  function addAd() {
    onChange([...ads, newAdDraft(ads.length + 1)]);
  }
  function removeAd(key: string) {
    onChange(ads.filter((a) => a.clientKey !== key));
  }

  function loadPosts() {
    if (posts !== null || postsLoading) return;
    setPostsLoading(true);
    getPosts()
      .then((r) => setPosts(r.posts))
      .catch(() => setPosts([]))
      .finally(() => setPostsLoading(false));
  }

  async function doUpload(ad: AdDraft, file: File) {
    update(ad.clientKey, { status: "uploading", error: null });
    try {
      const media = await uploadFile(file);
      update(ad.clientKey, { media, status: "draft" });
    } catch {
      update(ad.clientKey, { status: "error", error: "העלאת הקובץ נכשלה, אפשר לנסות שוב." });
    }
  }

  async function doCreate(ad: AdDraft) {
    update(ad.clientKey, { status: "creating", error: null });
    try {
      const body: AdCreativeBody =
        ad.source === "post"
          ? { clientKey: ad.clientKey, name: ad.name, postId: ad.postId! }
          : {
              clientKey: ad.clientKey, name: ad.name,
              headline: ad.headline, primaryText: ad.primaryText,
              whatsappNumber, destination, destinationUrl, media: ad.media!,
            };
      const { creativeId } = await createCreativeFn(body);
      update(ad.clientKey, { creativeId, status: "created" });
    } catch (e) {
      if (e instanceof CreativeValidationError) {
        update(ad.clientKey, {
          status: "error",
          error: e.errors.length ? e.errors.map(creativeValidationMessage).join(" ") : "בדקו את פרטי המודעה.",
        });
      } else if (e instanceof ApiError) {
        update(ad.clientKey, { status: "error", error: e.message });
      } else {
        update(ad.clientKey, { status: "error", error: "יצירת המודעה נכשלה." });
      }
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 8 }}>{c.body}</p>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 20 }}>{c.responsibilityNotice}</p>

      <div className="stack gap16">
        {ads.map((ad, i) => (
          <AdCard
            key={ad.clientKey}
            index={i + 1}
            ad={ad}
            posts={posts}
            postsLoading={postsLoading}
            onLoadPosts={loadPosts}
            onUpdate={(patch) => update(ad.clientKey, patch)}
            onUpload={(file) => doUpload(ad, file)}
            onCreate={() => doCreate(ad)}
            onRemove={ads.length > 1 ? () => removeAd(ad.clientKey) : undefined}
          />
        ))}
      </div>

      <div className="row gap12" style={{ marginTop: 16, alignItems: "center" }}>
        <button className="btn btn-outline btn-sm" onClick={addAd}>{c.addAd}</button>
        <span className="muted" style={{ fontSize: "0.85rem" }}>{c.countHint} ({ads.length})</span>
      </div>
    </div>
  );
}

function AdCard({
  index, ad, posts, postsLoading, onLoadPosts, onUpdate, onUpload, onCreate, onRemove,
}: {
  index: number;
  ad: AdDraft;
  posts: PromotablePost[] | null;
  postsLoading: boolean;
  onLoadPosts: () => void;
  onUpdate: (patch: Partial<AdDraft>) => void;
  onUpload: (file: File) => void;
  onCreate: () => void;
  onRemove?: () => void;
}) {
  const canCreate =
    ad.status !== "creating" && ad.status !== "created" &&
    (ad.source === "post" ? !!ad.postId : !!ad.media && !!ad.headline.trim() && !!ad.primaryText.trim());

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 12 }}>
        <b>{c.adTitle} {index}</b>
        <div className="row gap12">
          {ad.status === "created" && <StatusPill variant="ok">✓ {c.adCreated}</StatusPill>}
          {onRemove && ad.status !== "created" && (
            <button className="btn btn-outline btn-sm" onClick={onRemove}>{c.removeAd}</button>
          )}
        </div>
      </div>

      {ad.status !== "created" && (
        <>
          <div className="row gap12" style={{ marginBottom: 14 }}>
            <button
              className={`btn btn-sm ${ad.source === "upload" ? "btn-dark" : "btn-outline"}`}
              onClick={() => onUpdate({ source: "upload" })}
            >{c.uploadTab}</button>
            <button
              className={`btn btn-sm ${ad.source === "post" ? "btn-dark" : "btn-outline"}`}
              onClick={() => { onUpdate({ source: "post" }); onLoadPosts(); }}
            >{c.postTab}</button>
          </div>

          {ad.source === "upload" ? (
            <div className="stack gap12">
              <div className="field">
                <label>{c.chooseFile}</label>
                <input
                  type="file"
                  accept="image/*,video/*"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
                />
                {ad.status === "uploading" && <p className="muted" style={{ marginTop: 6 }}>{c.uploading}</p>}
                {ad.media && ad.status !== "uploading" && <p className="muted" style={{ marginTop: 6 }}>✓ {ad.media.kind === "image" ? "תמונה" : "וידאו"}</p>}
              </div>
              <div className="field">
                <label>{c.headlineLabel}</label>
                <input type="text" placeholder={c.headlinePlaceholder} value={ad.headline} onChange={(e) => onUpdate({ headline: e.target.value })} />
              </div>
              <div className="field">
                <label>{c.primaryTextLabel}</label>
                <textarea placeholder={c.primaryTextPlaceholder} value={ad.primaryText} onChange={(e) => onUpdate({ primaryText: e.target.value })} />
              </div>
            </div>
          ) : (
            <div>
              {postsLoading ? (
                <p className="muted">{c.loadingPosts}</p>
              ) : !posts || posts.length === 0 ? (
                <p className="muted">{c.noPosts}</p>
              ) : (
                <div className="stack gap12">
                  {posts.map((p) => (
                    <label key={p.id} className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                      <input type="radio" name={`post-${ad.clientKey}`} checked={ad.postId === p.id} onChange={() => onUpdate({ postId: p.id, postPreview: p.pictureUrl })} />
                      {p.pictureUrl && <img src={p.pictureUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }} />}
                      <span className="muted" style={{ fontSize: "0.9rem" }}>{p.message?.slice(0, 60) || p.id}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {ad.error && <p className="muted" style={{ marginTop: 12, color: "var(--orange)" }}>{ad.error}</p>}

          <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={!canCreate} onClick={onCreate}>
            {ad.status === "creating" ? c.creatingAd : c.createAdCta}
          </button>
        </>
      )}
    </div>
  );
}
