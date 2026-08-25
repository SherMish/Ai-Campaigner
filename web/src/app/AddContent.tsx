import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { normalizeBusinessCategory, resolveAudienceDefault, type BusinessCategory } from "@aic/shared";
import { strings } from "../strings";
import {
  getAdditionContext, getExistingAdSets, getPendingAdditions, approveAddition, getConnectedPage,
  addAd, addAdSet, ApiError, getConfig,
  uploadAdditionFile, getAdditionPosts, createAdditionCreative,
  type ExistingAdSet, type PendingAddition, type AdditionUnavailableReason,
} from "../api";
import { StatusPill, SupportCard, WA } from "./components";
import { AudienceFields, type Gender } from "./AudienceFields";
import { BuilderCreatives, newAdDraft, type AdDraft } from "./BuilderCreatives";

const s = strings.he.additions;
const c = strings.he.app.connect;

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function AddContent() {
  const [phase, setPhase] = useState<"loading" | "not_ready" | "ready" | "error">("loading");
  const [notReadyReason, setNotReadyReason] = useState<AdditionUnavailableReason>("no_campaign");
  const [idCopied, setIdCopied] = useState(false);
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [mode, setMode] = useState<"ad" | "ad_set">("ad");
  // AIC-103: [] means fully configured. Non-empty doesn't block the screen —
  // only the upload path actually needs this data; existing-post additions
  // stay available regardless (see AdditionContext.missingConfigFields).
  const [missingConfigFields, setMissingConfigFields] = useState<string[]>([]);

  // add-ad mode
  // AIC-132: who the ad appears to come from, for the preview header. Fetched
  // once and best-effort — a failure leaves the neutral placeholder rather than
  // blocking the screen.
  const [page, setPage] = useState<{ name: string | null; pictureUrl: string | null }>({ name: null, pictureUrl: null });
  const [adSets, setAdSets] = useState<ExistingAdSet[] | null>(null);
  const [adSetsLoading, setAdSetsLoading] = useState(false);
  const [selectedAdSetId, setSelectedAdSetId] = useState<string | null>(null);
  const [adDrafts, setAdDrafts] = useState<AdDraft[]>([newAdDraft(1)]);

  // add-ad-set mode
  const [category, setCategory] = useState<BusinessCategory>("other");
  const [audience, setAudience] = useState<{ ageMin: number; ageMax: number; gender: Gender }>({ ageMin: 18, ageMax: 65, gender: "all" });
  const [setName, setSetName] = useState("");
  const [groupAdDrafts, setGroupAdDrafts] = useState<AdDraft[]>([newAdDraft(1), newAdDraft(2), newAdDraft(3)]);

  const [additionKey, setAdditionKey] = useState(freshKey);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState(false);
  // AIC-106: creating content activates it immediately — true in the
  // overwhelmingly common case. False only means the create itself
  // succeeded but activation didn't (a rare Meta-side hiccup); the pending
  // section below still shows it with a retry button, same recovery path
  // as before, just no longer the normal one.
  const [justAddedLive, setJustAddedLive] = useState(true);

  const [pending, setPending] = useState<PendingAddition[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    getAdditionContext()
      .then((ctx) => {
        setWhatsappNumber(ctx.whatsappDestination);
        const cat = normalizeBusinessCategory(ctx.category);
        setCategory(cat);
        const d = resolveAudienceDefault(cat);
        setAudience({ ageMin: d.ageMin, ageMax: d.ageMax, gender: d.genders });
        setMissingConfigFields(ctx.missingConfigFields);
        setPhase("ready");
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          const reason = (e.body as { reason?: AdditionUnavailableReason } | undefined)?.reason;
          setNotReadyReason(reason ?? "no_campaign");
          setPhase("not_ready");
          return;
        }
        setPhase("error");
      });
    refreshPending();
    getConfig().then((c) => setPortfolioId(c.businessPortfolioId)).catch(() => {});
  }, []);

  function refreshPending() {
    getPendingAdditions().then((r) => setPending(r.pending)).catch(() => {});
  }

  function loadAdSets() {
    if (adSets !== null || adSetsLoading) return;
    setAdSetsLoading(true);
    getExistingAdSets()
      .then((r) => {
        setAdSets(r.adSets);
        // AIC-132: with exactly one ad set there is no decision to make, and
        // leaving it unpicked produced a dead submit button the customer had
        // no reason to connect to an unticked radio they never saw.
        if (r.adSets.length === 1) setSelectedAdSetId(r.adSets[0].id);
      })
      .catch(() => setAdSets([]))
      .finally(() => setAdSetsLoading(false));
  }

  useEffect(() => {
    if (mode === "ad" && phase === "ready") loadAdSets();
    if (phase === "ready") getConnectedPage().then(setPage).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase]);

  function switchMode(next: "ad" | "ad_set") {
    setMode(next);
    setAdditionKey(freshKey());
    setSubmitError(null);
    setJustAdded(false);
  }

  async function submitAd() {
    if (!selectedAdSetId) return;
    const created = adDrafts.filter((d) => d.creativeId);
    if (created.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let allLive = true;
      for (const draft of created) {
        const result = await addAd({ metaAdSetId: selectedAdSetId, name: draft.name, creativeId: draft.creativeId!, additionKey: `${additionKey}-${draft.clientKey}` });
        if (result.activation.outcome !== "approved" && result.activation.outcome !== "already_approved") allLive = false;
      }
      setJustAddedLive(allLive);
      setJustAdded(true);
      refreshPending();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : s.submitError);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAdSet() {
    const created = groupAdDrafts.filter((d) => d.creativeId);
    if (!setName.trim() || created.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await addAdSet({
        name: setName,
        targeting: { ageMin: audience.ageMin, ageMax: audience.ageMax, genders: audience.gender },
        ads: created.map((d) => ({ clientKey: d.clientKey, name: d.name, creativeId: d.creativeId! })),
        additionKey,
      });
      setJustAddedLive(result.activation.outcome === "approved" || result.activation.outcome === "already_approved");
      setJustAdded(true);
      refreshPending();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : s.submitError);
    } finally {
      setSubmitting(false);
    }
  }

  function addAnother() {
    setJustAdded(false);
    setAdditionKey(freshKey());
    setSelectedAdSetId(null);
    setAdDrafts([newAdDraft(1)]);
    setSetName("");
    setGroupAdDrafts([newAdDraft(1), newAdDraft(2), newAdDraft(3)]);
    setAdSets(null);
    if (mode === "ad") loadAdSets();
  }

  async function doApprove(id: string) {
    setApprovingId(id);
    setApproveError(null);
    try {
      const result = await approveAddition(id);
      if (result.outcome !== "approved" && result.outcome !== "already_approved") {
        setApproveError(s.approveError);
      }
      refreshPending();
    } catch {
      setApproveError(s.approveError);
    } finally {
      setApprovingId(null);
    }
  }

  if (phase === "loading") return <div className="wrap page"><p className="muted">{strings.he.app.loading}</p></div>;
  if (phase === "not_ready") {
    // Four distinct reasons, four distinct responses — sending a customer
    // with an already-active campaign to the builder (which itself refuses
    // to run once a campaign exists) is the exact dead end this branch
    // exists to avoid. missing_page gets its own branch rather than folding
    // into the generic "check settings" message: it's both the most common
    // real cause and the one with a precise, known fix — the exact copy
    // onboarding's Connect screen already has (missingBody/fixSteps),
    // reused here rather than duplicated, since it's otherwise invisible to
    // anyone past onboarding.
    if (notReadyReason === "missing_page") {
      return (
        <div className="wrap page">
          <div className="card">
            <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 8 }}>{c.missingTitle}</b>
            <p className="muted" style={{ marginBottom: 16 }}>{c.missingBody}</p>
            <b>{c.howToFix}</b>
            <ol className="muted" style={{ margin: "8px 0 20px", paddingInlineStart: 20 }}>
              {c.fixSteps.map((f, i) => (
                <li key={i}>
                  {f}
                  {i === 2 && (
                    <div className="copybox" style={{ marginTop: 10 }}>
                      <span className="mono muted" style={{ fontSize: "0.7rem" }}>{c.businessId}</span>
                      <b>{portfolioId ?? "…"}</b>
                      <button
                        disabled={!portfolioId}
                        onClick={() => { if (portfolioId) { navigator.clipboard?.writeText(portfolioId); setIdCopied(true); } }}
                      >
                        {idCopied ? c.copied : c.copy}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <Link className="btn btn-primary btn-sm" to="/app/settings">{s.goToSettings}</Link>
          </div>
        </div>
      );
    }
    const content =
      notReadyReason === "not_launched"
        // CTA follows the corrected meaning: an unfinished BUILD is resumed in
        // the builder, not "approved" on the home page (that step is gone —
        // AIC-106). Sending them home offered nothing to act on.
        ? { title: s.notLaunchedTitle, body: s.notLaunchedBody, cta: s.goToBuilder, to: "/app/builder" }
        : notReadyReason === "connection_issue"
          ? { title: s.connectionIssueTitle, body: s.connectionIssueBody, cta: s.goToSettings, to: "/app/settings" }
          : { title: s.notReadyTitle, body: s.notReadyBody, cta: s.goToBuilder, to: "/app/builder" };
    return (
      <div className="wrap page">
        <div className="card">
          <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 8 }}>{content.title}</b>
          <p className="muted" style={{ marginBottom: 16 }}>{content.body}</p>
          <Link className="btn btn-primary btn-sm" to={content.to}>{content.cta}</Link>
        </div>
      </div>
    );
  }
  if (phase === "error") return <div className="wrap page"><div className="card"><p className="muted">{s.unavailable}</p></div></div>;

  const adReady = !!selectedAdSetId && adDrafts.some((d) => d.creativeId);
  const adSetReady = !!setName.trim() && groupAdDrafts.some((d) => d.creativeId);

  return (
    <div className="wrap page">
      <div style={{ marginBottom: 24 }}>
        <div className="eyebrow">{s.eyebrow}</div>
        <h1 style={{ marginTop: 10 }}>{s.title}</h1>
      </div>

      {missingConfigFields.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <b style={{ fontSize: "1.05rem", display: "block", marginBottom: 8 }}>{s.incompleteConfigTitle}</b>
          <p style={{ marginBottom: 6 }}>{s.incompleteConfigIntro}</p>
          {/* Name the actual field(s). The list was always on the client and
              was being thrown away for a generic sentence, which is what made
              the message unactionable. */}
          <ul style={{ margin: "0 0 12px", paddingInlineStart: 20 }}>
            {missingConfigFields.map((f) => (
              <li key={f}><b>{s.incompleteConfigFields[f] ?? f}</b></li>
            ))}
          </ul>
          {/* Ask the person who can actually answer. A landing-page URL or a
              WhatsApp number is the customer's to give; a Pixel id or the
              lead-event definition is ours. The old copy claimed BOTH cases
              were handled by us, which is why one sat unresolved for weeks. */}
          <p className="muted" style={{ marginBottom: 12 }}>
            {missingConfigFields.some((f) => f === "website_url" || f === "whatsapp_destination")
              ? s.incompleteConfigAskYou
              : s.incompleteConfigAskUs}
          </p>
          <p className="muted" style={{ marginBottom: 12 }}>{s.incompleteConfigMeanwhile}</p>
          <a className="btn btn-wa btn-sm" href={WA}>{strings.he.app.talkWa}</a>
        </div>
      )}

      <div className="grid-2">
        <div>
          <div className="row gap12" style={{ marginBottom: 20 }}>
            <button className={`btn btn-sm ${mode === "ad" ? "btn-dark" : "btn-outline"}`} onClick={() => switchMode("ad")}>{s.modeAd}</button>
            <button className={`btn btn-sm ${mode === "ad_set" ? "btn-dark" : "btn-outline"}`} onClick={() => switchMode("ad_set")}>{s.modeAdSet}</button>
          </div>

          {justAdded ? (
            <div className="card">
              <StatusPill variant={justAddedLive ? "ok" : "warn"}>{justAddedLive ? "✓" : "!"}</StatusPill>
              <b style={{ fontSize: "1.2rem", display: "block", margin: "14px 0 10px" }}>
                {justAddedLive ? s.submitSuccessTitle : s.submitSuccessTitleRetry}
              </b>
              <p className="muted" style={{ marginBottom: 20 }}>
                {justAddedLive ? s.submitSuccessBody : s.submitSuccessBodyRetry}
              </p>
              <button className="btn btn-primary btn-sm" onClick={addAnother}>{s.submitAnother}</button>
            </div>
          ) : mode === "ad" ? (
            <div className="stack gap16">
              <div className="card">
                <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 12 }}>{s.pickAdSetTitle}</b>
                {adSetsLoading ? (
                  <p className="muted">{s.pickAdSetLoading}</p>
                ) : !adSets || adSets.length === 0 ? (
                  // AIC-130: an explanation and a way out, not a dead end. This
                  // used to be one muted line with the whole creative builder
                  // still live underneath it, so the customer did all the work
                  // and then hit a disabled button that said nothing.
                  <div className="stack gap12">
                    <p className="muted" style={{ margin: 0 }}>{s.noAdSets}</p>
                    <p className="muted" style={{ margin: 0 }}>{s.noAdSetsBody}</p>
                    <div>
                      <button className="btn btn-primary btn-sm" onClick={() => switchMode("ad_set")}>
                        {s.noAdSetsCta}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="stack gap12">
                    {adSets.map((set) => (
                      <label key={set.id} className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                        <input type="radio" name="ad-set-pick" checked={selectedAdSetId === set.id} onChange={() => setSelectedAdSetId(set.id)} />
                        <span>{set.name || set.id}</span>
                        {set.status === "paused" && <StatusPill variant="neutral">{s.adSetPaused}</StatusPill>}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* AIC-130: with no ad set there is nowhere for an ad to go, so
                  don't invite the work. This whole section used to stay live
                  and the submit button below merely went grey — the customer
                  uploaded creatives, saw them confirmed, and only then found a
                  dead button with no explanation on it. */}
              {(adSets?.length ?? 0) > 0 && (
                <>
                  <div className="card">
                    <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 12 }}>{s.adsTitle}</b>
                    <BuilderCreatives
                      businessName={page.name ?? undefined}
                      pagePictureUrl={page.pictureUrl}
                      ads={adDrafts}
                      onChange={setAdDrafts}
                      whatsappNumber={whatsappNumber}
                      getPosts={getAdditionPosts}
                      uploadFile={uploadAdditionFile}
                      createCreativeFn={createAdditionCreative}
                    />
                  </div>

                  {submitError && <p className="muted" style={{ color: "var(--orange)" }}>{submitError}</p>}
                  {/* AIC-132: a disabled button that explains nothing is the
                      same dead end as the missing-ad-set screen, just later in
                      the flow — the customer sees "התוכן מוכן ✓" and a greyed
                      button and reasonably concludes something broke. House
                      rule (AIC-98): never render a blank where a reason exists. */}
                  {!adReady && !submitting && (
                    <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                      {s.blockedPrefix}{" "}
                      {[
                        !selectedAdSetId ? s.blockedPickAdSet : null,
                        !adDrafts.some((dr) => dr.creativeId) ? s.blockedNeedCreative : null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <button className="btn btn-primary btn-wide" disabled={!adReady || submitting} onClick={submitAd}>
                    {submitting ? s.submitting : s.submitAdCta}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="stack gap16">
              <div className="card">
                <div className="field">
                  <label>{s.adSetNameLabel}</label>
                  <input type="text" placeholder={s.adSetNamePlaceholder} value={setName} onChange={(e) => setSetName(e.target.value)} />
                </div>
              </div>

              <div className="card">
                <AudienceFields
                  category={category}
                  value={audience}
                  onCategoryChange={setCategory}
                  onChange={(patch) => setAudience((prev) => ({ ...prev, ...patch }))}
                />
              </div>

              <div className="card">
                <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 12 }}>{strings.he.builder.creatives.title}</b>
                <BuilderCreatives
                  businessName={page.name ?? undefined}
                  pagePictureUrl={page.pictureUrl}
                  ads={groupAdDrafts}
                  onChange={setGroupAdDrafts}
                  whatsappNumber={whatsappNumber}
                  getPosts={getAdditionPosts}
                  uploadFile={uploadAdditionFile}
                  createCreativeFn={createAdditionCreative}
                />
              </div>

              {submitError && <p className="muted" style={{ color: "var(--orange)" }}>{submitError}</p>}
              <button className="btn btn-primary btn-wide" disabled={!adSetReady || submitting} onClick={submitAdSet}>
                {submitting ? s.submitting : s.submitAdSetCta}
              </button>
            </div>
          )}

          <div className="card" style={{ marginTop: 24 }}>
            <b style={{ fontSize: "1.1rem", display: "block", marginBottom: 12 }}>{s.pendingTitle}</b>
            {pending.length === 0 ? (
              <p className="muted">{s.pendingEmpty}</p>
            ) : (
              <div className="stack gap12">
                {pending.map((p) => (
                  <div key={p.id} className="row between" style={{ alignItems: "center" }}>
                    <span>
                      <b>{p.name}</b>{" "}
                      <span className="muted" style={{ fontSize: "0.85rem" }}>({p.kind === "ad_set" ? s.pendingKindAdSet : s.pendingKindAd})</span>
                    </span>
                    <button className="btn btn-outline btn-sm" disabled={approvingId === p.id} onClick={() => doApprove(p.id)}>
                      {approvingId === p.id ? s.approving : s.approveCta}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {approveError && <p className="muted" style={{ color: "var(--orange)", marginTop: 12 }}>{approveError}</p>}
          </div>
        </div>
        <SupportCard />
      </div>
    </div>
  );
}
