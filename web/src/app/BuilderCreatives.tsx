import { useEffect, useRef, useState } from "react";
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
  // AIC-130, client-only and never sent: an object URL for the file the
  // customer just picked, so the dropzone and the preview can show the actual
  // picture. The server's UploadedMedia gives back an imageHash with no URL
  // (Meta hosts it), so there is nothing else to render it from.
  localPreviewUrl: string | null;
  postId: string | null;
  postPreview: string | null;
  // AIC-132: the post's own copy, so the preview can show what the ad will
  // actually say. Client-only, never sent — the creative is built from postId.
  postMessage: string | null;
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
    localPreviewUrl: null,
    postId: null,
    postPreview: null,
    postMessage: null,
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
  // AIC-130/132: who the ad appears to come from, in the preview header. The
  // Page's real name and profile photo when we can read them (AIC-132), else
  // just a name, else a neutral placeholder — the preview stays useful at every
  // level, so a caller missing this is never blocked from rendering one.
  businessName?: string;
  pagePictureUrl?: string | null;
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
  // AIC-105 Branch A: present when Builder.tsx is reused in admin mode (an
  // operator building on a customer's behalf) — threaded into the default
  // getPosts/uploadFile/createCreativeFn below so they hit the admin-mounted
  // routes instead of the customer's own. Has no effect on a caller that
  // supplies its own functions (AddContent.tsx never passes this).
  customerId?: string;
  // AIC-107: engagement campaigns can only promote an existing Page post.
  postsOnly?: boolean;
  // AIC-63: injectable so AddContent.tsx can point creative creation at
  // /app/additions/* instead of /app/builder/* — same component and UI,
  // different backend routes. Defaults to the builder's own endpoints.
  getPosts?: () => Promise<{ posts: PromotablePost[] }>;
  uploadFile?: (file: File) => Promise<UploadedMedia>;
  createCreativeFn?: (body: AdCreativeBody) => Promise<{ creativeId: string }>;
}

export function BuilderCreatives({
  ads, onChange, localCampaignId, whatsappNumber, destination, destinationUrl, customerId,
  businessName, pagePictureUrl,
  postsOnly = false,
  getPosts = () => getPromotablePosts(customerId),
  uploadFile = (file) => uploadCreativeFile(file, customerId),
  createCreativeFn = (body) => createCreative({ ...body, localCampaignId } as CreateCreativeBody, customerId),
}: Props) {
  const [posts, setPosts] = useState<PromotablePost[] | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);

  // AIC-107: with no upload tab to click, nothing would ever switch a draft
  // off its "upload" default or trigger the post fetch — the step would look
  // permanently empty. Force both here instead.
  useEffect(() => {
    if (!postsOnly) return;
    loadPosts();
    const wrong = ads.filter((a) => a.source !== "post");
    if (wrong.length) onChange(ads.map((a) => (a.source === "post" ? a : { ...a, source: "post" })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postsOnly, ads]);

  // AIC-132, found live: "the photo appears for 1 sec and disappears".
  //
  // `ads` is a PROP, captured at render. doUpload calls update() twice in one
  // async function — once to show the picked file immediately, once when the
  // upload returns — and both closed over the SAME pre-upload array. The second
  // call rebuilt the draft from that stale snapshot, so `localPreviewUrl` set by
  // the first was silently dropped. The picture showed for exactly as long as
  // the upload took, then vanished.
  //
  // Composing through a ref makes sequential updates build on each other
  // instead of each starting from the last render. Every multi-step handler
  // here has the same shape (doCreate patches status, then the result), so this
  // is the general fix rather than threading the lost field back through by
  // hand at one call site.
  const latest = useRef(ads);
  latest.current = ads;
  function update(key: string, patch: Partial<AdDraft>) {
    const next = latest.current.map((a) => (a.clientKey === key ? { ...a, ...patch } : a));
    latest.current = next;
    onChange(next);
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
    // AIC-130: shown immediately, before the upload finishes — the customer
    // picked this file, so the picture is the fastest possible confirmation
    // that the right one is going up. Revoked when replaced so a customer who
    // re-picks several times doesn't leak a blob per attempt.
    if (ad.localPreviewUrl) URL.revokeObjectURL(ad.localPreviewUrl);
    const localPreviewUrl = URL.createObjectURL(file);
    update(ad.clientKey, { status: "uploading", error: null, localPreviewUrl });
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
            postsOnly={postsOnly}
            onUpdate={(patch) => update(ad.clientKey, patch)}
            onUpload={(file) => doUpload(ad, file)}
            previewBusinessName={businessName}
            previewPictureUrl={pagePictureUrl}
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
  index, ad, posts, postsLoading, onLoadPosts, postsOnly, onUpdate, onUpload, onCreate, onRemove,
  previewBusinessName, previewPictureUrl,
}: {
  index: number;
  ad: AdDraft;
  posts: PromotablePost[] | null;
  postsLoading: boolean;
  onLoadPosts: () => void;
  postsOnly: boolean;
  onUpdate: (patch: Partial<AdDraft>) => void;
  onUpload: (file: File) => void;
  previewBusinessName?: string;
  previewPictureUrl?: string | null;
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
          {/* AIC-107: an engagement ad promotes an EXISTING Page post — an
              uploaded creative has no post to engage with, and the adapter
              refuses it (no CTA shape). So the choice isn't offered, and
              per AIC-98 the reason is stated rather than the tab silently
              vanishing. */}
          {postsOnly ? (
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 14 }}>{c.postsOnlyNote}</p>
          ) : (
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
          )}

          {ad.source === "upload" ? (
            <div className="stack gap12">
              <div className="field">
                <label>{c.chooseFile}</label>
                <MediaDropzone ad={ad} onUpload={onUpload} />
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
                      <input type="radio" name={`post-${ad.clientKey}`} checked={ad.postId === p.id} onChange={() => onUpdate({ postId: p.id, postPreview: p.pictureUrl, postMessage: p.message ?? null })} />
                      {p.pictureUrl && <img src={p.pictureUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }} />}
                      <span className="muted" style={{ fontSize: "0.9rem" }}>{p.message?.slice(0, 60) || p.id}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AIC-132: OUTSIDE the source branches, because both need it. It
              used to sit inside the upload arm only, so choosing an existing
              post — the path where there is already a real picture to show —
              got no preview at all. Reported live as "still don't see the image
              in the preview". */}
          <div className="field" style={{ marginTop: 14 }}>
            <label>{c.previewTitle}</label>
            <AdPreview ad={ad} businessName={previewBusinessName} pictureUrl={previewPictureUrl} />
            <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{c.previewNote}</p>
          </div>

          {ad.error && <p className="muted" style={{ marginTop: 12, color: "var(--orange)" }}>{ad.error}</p>}

          <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={!canCreate} onClick={onCreate}>
            {ad.status === "creating" ? c.creatingAd : c.createAdCta}
          </button>
        </>
      )}
    </div>
  );
}

// AIC-130. Replaces a bare <input type="file">, which the browser renders as
// its own grey "Choose File / No file chosen" control — English chrome in the
// middle of a Hebrew screen, and the least considered element in the product
// at the exact moment a customer hands us the photo of their work.
//
// Drag-and-drop is the reason this is a component rather than a styled label:
// people already have the picture open in a folder, and the native control
// cannot accept a drop.
function MediaDropzone({ ad, onUpload }: { ad: AdDraft; onUpload: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploading = ad.status === "uploading";
  const has = !!ad.localPreviewUrl || !!ad.media;

  function take(files: FileList | null | undefined) {
    const f = files?.[0];
    // Guard the drop path specifically: `accept` constrains the file PICKER,
    // and a drag-and-drop bypasses it entirely — without this, dropping a PDF
    // would upload it and fail server-side with a worse message.
    if (f && /^(image|video)\//.test(f.type)) onUpload(f);
  }

  return (
    <>
      <div
        className={`dropzone${over ? " is-over" : ""}${has ? " has-file" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      >
        {has ? (
          <div className="row gap12" style={{ alignItems: "center" }}>
            {ad.localPreviewUrl && ad.media?.kind !== "video" ? (
              <img className="dz-thumb" src={ad.localPreviewUrl} alt="" />
            ) : ad.media?.kind === "video" ? (
              <img className="dz-thumb" src={ad.media.thumbnailUrl} alt="" />
            ) : null}
            <div className="stack" style={{ gap: 4, textAlign: "start" }}>
              <span className="dz-title">
                {uploading ? c.uploading : `✓ ${ad.media?.kind === "video" ? c.dropVideo : c.dropImage}`}
              </span>
              <button
                type="button"
                className="link"
                style={{ background: "none", border: "none", padding: 0, fontSize: ".8rem", cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
              >
                {c.dropReplace}
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="dz-title">{c.dropTitle}</span>
            <span className="dz-hint">{c.dropHint}</span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        style={{ display: "none" }}
        onChange={(e) => { take(e.target.files); e.target.value = ""; }}
      />
    </>
  );
}

// AIC-130. What the three form fields actually add up to.
//
// The form asks for "כותרת" and "טקסט ראשי" as two boxes of the same size,
// which says nothing about where either one lands — and they land in very
// different places: the primary text is the big paragraph ABOVE the picture,
// the headline is the small bold line UNDER it, next to the button. Customers
// reasonably assume the "headline" is the prominent one and write accordingly.
//
// Deliberately a SKETCH, not a facsimile. Meta reformats per placement (feed,
// reels, stories all differ), so a pixel-accurate Facebook render would be
// claiming something we cannot deliver — the note under it says so. What this
// does show reliably is which field goes where.
function AdPreview({ ad, businessName, pictureUrl }: {
  ad: AdDraft;
  businessName?: string;
  pictureUrl?: string | null;
}) {
  const name = businessName?.trim() || c.previewYourBusiness;
  // Three sources, in the order of what is most certainly correct:
  //   1. the local file just picked — an uploaded IMAGE has no URL at all
  //      (Meta returns only an imageHash), which is why the draft carries one
  //   2. Meta's thumbnail for an uploaded video
  //   3. the chosen existing POST's own picture — AIC-132: this was missing
  //      entirely, on the one path where a real picture already exists
  const src =
    ad.localPreviewUrl ??
    (ad.media?.kind === "video" ? ad.media.thumbnailUrl : null) ??
    ad.postPreview;
  return (
    <div className="ad-preview">
      <div className="apv-head">
        {/* The real Page photo when we have it. The initial-in-a-circle is a
            fallback, not the design — the customer recognises their own Page
            picture instantly, and a grey letter is the difference between a
            mock-up they trust and one they squint at. */}
        {pictureUrl ? (
          <img className="apv-avatar" src={pictureUrl} alt="" style={{ objectFit: "cover" }} />
        ) : (
          <div className="apv-avatar" aria-hidden="true">{name.slice(0, 1)}</div>
        )}
        <div>
          <div className="apv-name"><bdi>{name}</bdi></div>
          <div className="apv-sponsored">{c.previewSponsored}</div>
        </div>
      </div>
      {/* Placeholders rather than a collapsed layout: an empty preview should
          still show the SHAPE, since seeing where the text will sit is the
          whole reason to look at it before writing. */}
      <div className="apv-body">
        {/* An existing post carries its OWN copy; the headline/primary-text
            fields are not even shown on that path, so reading them would
            render an empty placeholder over a post that has real text. */}
        {/* NOT <bdi> — AIC-132, found live. bdi picks its direction from the
            FIRST STRONG CHARACTER, so ad copy beginning with a Latin brand name
            ("Ads Agent מנהל את הקמפיין…") made the whole Hebrew paragraph
            render LTR: full stops jumped to the start of lines and the brand
            name slid to the end of the sentence.
            A plain element inherits the page's RTL and lets the bidi algorithm
            place the embedded Latin runs correctly, which is the entire job. */}
        {ad.source === "post" ? (
          ad.postMessage?.trim()
            ? ad.postMessage
            : <span className="muted">{c.previewPostNoText}</span>
        ) : ad.primaryText.trim() ? (
          ad.primaryText
        ) : (
          <span className="muted">{c.previewEmptyText}</span>
        )}
      </div>
      {src ? (
        <img className="apv-media" src={src} alt="" />
      ) : (
        <div className="apv-media-empty">{c.previewEmptyMedia}</div>
      )}
      <div className="apv-foot">
        <span className="apv-headline">
          {ad.source === "post" ? (
            <span className="muted">{c.previewPostHeadline}</span>
          ) : ad.headline.trim() ? (
            ad.headline
          ) : (
            <span className="muted">{c.previewEmptyHeadline}</span>
          )}
        </span>
        <span className="apv-cta">{c.previewCta}</span>
      </div>
    </div>
  );
}
