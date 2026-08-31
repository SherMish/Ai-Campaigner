import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  RECOMMENDED_BUDGET_AGOROT_PER_DAY, RECOMMENDED_SPECIAL_AD_CATEGORY,
  SPECIAL_AD_CATEGORY, resolveAudienceDefault, normalizeBusinessCategory,
  FIXED_DESTINATION, WEBSITE_DESTINATION, ENGAGEMENT_DESTINATION, LEAD_CONVERSION_EVENTS,
  type SpecialAdCategory, type BusinessCategory,
} from "@aic/shared";
import { strings } from "../strings";
import {
  getBuilderContext, getBuilderPage, startBuilder, buildCampaign, getBuilderPixels, checkBuilderPixel, ApiError,
  type GeoPlace,
  type BuildCampaignResult, type PixelOption,
} from "../api";
import { Stepper, StatusPill, SupportCard, Recommended } from "./components";
import { BuilderCreatives, newAdDraft, type AdDraft } from "./BuilderCreatives";
import { AudienceFields, type Gender } from "./AudienceFields";

const b = strings.he.builder;
const g = b.goal, ds = b.destination, bg = b.budget, sc = b.specialCategory, au = b.audience, pl = b.placements, rv = b.review;

interface WizardState {
  // AIC-89: a real choice now — FIXED_DESTINATION (WhatsApp, the
  // recommended default) or WEBSITE_DESTINATION.
  destination: string;
  whatsappNumber: string;
  destinationUrl: string;
  pixelId: string;
  conversionEvent: string;
  dailyBudgetShekels: number;
  specialCategory: SpecialAdCategory;
  ageMin: number;
  ageMax: number;
  gender: Gender;
  // AIC-157 — where the ads run. Empty = all of Israel, which used to be the
  // only possibility.
  cities: GeoPlace[];
}

interface Props {
  // AIC-105 Branch A: present when an operator is building a customer's
  // FIRST campaign on their behalf (mounted at /admin/customers/:id/builder)
  // instead of the customer's own self-serve session. Threaded straight into
  // every api.ts call below — same UI, same 8 steps, only which backend
  // route answers changes (see api.ts's builderBasePath).
  customerId?: string;
  // Admin mode has nowhere sensible to "go home" to — the operator exits
  // back to the onboarding wizard they launched this from, not the SPA's
  // customer shell. Defaults to the customer's own /app.
  onExit?: () => void;
}

// Draft persistence (user decision, 2026-08-19). Replaces AIC-50's
// resume-on-Meta design: what an operator actually wants back after a failed
// build is the work they TYPED — budget, audience, ad copy — not half-created
// Meta objects. So the answers live here, and Meta stays all-or-nothing.
//
// Scoped per customer, because this wizard is also driven by an operator
// running several onboardings in one session. Without that, a half-filled
// wizard from one customer's call would restore into the next customer's.
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const draftKey = (customerId?: string) => `aic_builder_draft:${customerId ?? "self"}`;

/*
 * AIC-157 — the review's location line, DERIVED.
 *
 * It used to be `rv.geoValue`, a constant reading "כל ישראל" printed whatever
 * the campaign targeted. It happened to be true when nothing else was
 * possible; the moment a picker existed it would have become a confident lie
 * on the last screen before spend starts.
 *
 * Names beyond the first two are counted rather than listed — a review line
 * that wraps to three rows stops being a review.
 */
function geoSummary(cities: GeoPlace[]): string {
  if (cities.length === 0) return strings.he.builder.audience.geoAllIsrael;
  if (cities.length <= 2) return cities.map((c) => c.name).join(", ");
  return strings.he.builder.audience.geoSelectedCount.replace("{n}", String(cities.length));
}

function loadDraft(customerId?: string): WizardState | null {
  try {
    const raw = localStorage.getItem(draftKey(customerId));
    if (!raw) return null;
    const { savedAt, wizard } = JSON.parse(raw) as { savedAt: number; wizard: WizardState };
    // Expiry is the safety property, not housekeeping: a stale draft from an
    // earlier call must never silently reappear mid-conversation with someone
    // else. Anything past the TTL is dropped rather than offered.
    if (!savedAt || Date.now() - savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftKey(customerId));
      return null;
    }
    // A draft written before AIC-157 has no `cities` key at all. Filling it
    // here rather than at every read keeps the rest of the wizard able to
    // assume the field exists.
    return wizard ? { ...wizard, cities: wizard.cities ?? [] } : null;
  } catch {
    // Corrupt/unparseable draft is not worth a broken wizard — start clean.
    return null;
  }
}

function saveDraft(customerId: string | undefined, wizard: WizardState): void {
  try {
    localStorage.setItem(draftKey(customerId), JSON.stringify({ savedAt: Date.now(), wizard }));
  } catch { /* quota/private mode — a lost draft must never block the build */ }
}

function clearDraft(customerId?: string): void {
  try { localStorage.removeItem(draftKey(customerId)); } catch { /* ignore */ }
}

export function Builder({ customerId, onExit }: Props = {}) {
  const nav = useNavigate();
  const exit = onExit ?? (() => nav("/app"));
  const [phase, setPhase] = useState<"loading" | "not_ready" | "ready" | "error">("loading");
  const [category, setCategory] = useState<BusinessCategory>("other");
  // AIC-106 — from the customer record via /builder/context, never typed here.
  const [businessName, setBusinessName] = useState("");
  // AIC-155: the PAGE, which is who Meta publishes the ad as — not
  // businessName, which is what we typed into the customers row. Loaded
  // separately from the context so its two live Meta reads never delay the
  // builder's load, and a failure costs the preview header alone.
  const [page, setPage] = useState<{ name: string | null; pictureUrl: string | null }>({ name: null, pictureUrl: null });
  // AIC-106 follow-up, found live: the wizard accepted ₪40/day against an
  // agreed ceiling of ₪20 and only refused on the FINAL click, after every
  // step was filled. The ceiling is known from provisioning, so the budget
  // step can refuse it where it is typed.
  const [agreedBudgetAgorot, setAgreedBudgetAgorot] = useState<number | null>(null);
  const [localCampaignId, setLocalCampaignId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [ads, setAds] = useState<AdDraft[]>([newAdDraft(1), newAdDraft(2), newAdDraft(3)]);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildCampaignResult | null>(null);

  // AIC-89: the Pixel picker's own data, loaded only once the website
  // destination is actually chosen (never fetched for the WhatsApp path).
  const [pixels, setPixels] = useState<PixelOption[] | null>(null);
  const [pixelsLoading, setPixelsLoading] = useState(false);
  const [pixelRecent, setPixelRecent] = useState<boolean | null>(null);
  const [pixelChecking, setPixelChecking] = useState(false);

  useEffect(() => {
    getBuilderContext(customerId)
      .then((ctx) => {
        // Normalize the operator-typed category to a known value so the
        // selector shows a real, correctable option (never a blank/mystery).
        const cat = normalizeBusinessCategory(ctx.category);
        setCategory(cat);
        setBusinessName(ctx.businessName ?? "");
        getBuilderPage(customerId).then(setPage).catch(() => {
          /* the preview falls back to the placeholder — never break the step */
        });
        setAgreedBudgetAgorot(ctx.agreedBudgetAgorot ?? null);
        const aud = resolveAudienceDefault(cat);
        // A saved draft wins over the defaults — that is the whole point of
        // keeping it. loadDraft has already dropped anything expired.
        const draft = loadDraft(customerId);
        setWizard(draft ?? {
          destination: FIXED_DESTINATION,
          whatsappNumber: "",
          destinationUrl: "",
          pixelId: "",
          conversionEvent: "",
          dailyBudgetShekels: RECOMMENDED_BUDGET_AGOROT_PER_DAY.recommended / 100,
          specialCategory: RECOMMENDED_SPECIAL_AD_CATEGORY,
          ageMin: aud.ageMin, ageMax: aud.ageMax, gender: aud.genders,
          cities: [],
        });
        return startBuilder(customerId);
      })
      .then((r) => { setLocalCampaignId(r.localCampaignId); setPhase("ready"); })
      .catch((e) => setPhase(e instanceof ApiError && e.status === 409 ? "not_ready" : "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "loading") {
    return <div className="wrap page"><p className="muted">{strings.he.app.loading}</p></div>;
  }
  if (phase === "not_ready") {
    return (
      <div className="wrap page">
        <div className="card">
          <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 8 }}>{b.notReadyTitle}</b>
          <p className="muted" style={{ marginBottom: 16 }}>{b.notReadyBody}</p>
          <button className="btn btn-primary btn-sm" onClick={exit}>{b.backToAccount}</button>
        </div>
      </div>
    );
  }
  if (phase === "error" || !wizard || !localCampaignId) {
    return (
      <div className="wrap page">
        <div className="card"><p className="muted">{b.unavailable}</p></div>
      </div>
    );
  }

  function patch(p: Partial<WizardState>) {
    setWizard((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...p };
      saveDraft(customerId, next); // every edit persists — no separate "save" step
      return next;
    });
  }

  function chooseDestination(dest: string) {
    // Switching destination clears the other branch's fields rather than
    // leaving stale data that could accidentally be sent — a customer who
    // picks website after typing a WhatsApp number never has that number
    // silently submitted alongside a URL.
    patch(dest === FIXED_DESTINATION
      ? { destination: dest, destinationUrl: "", pixelId: "", conversionEvent: "" }
      : { destination: dest, whatsappNumber: "" });
    setPixelRecent(null);
    if (dest === WEBSITE_DESTINATION && pixels === null && !pixelsLoading) {
      setPixelsLoading(true);
      getBuilderPixels(customerId).then((r) => setPixels(r.pixels)).catch(() => setPixels([])).finally(() => setPixelsLoading(false));
    }
  }

  // Re-checks recency whenever BOTH the pixel and event are chosen — never a
  // stale warning left over from a previous selection.
  function runPixelCheck(pixelId: string, conversionEvent: string) {
    if (!pixelId || !conversionEvent) { setPixelRecent(null); return; }
    setPixelChecking(true);
    checkBuilderPixel(pixelId, conversionEvent, customerId)
      .then((r) => setPixelRecent(r.hasRecentEvents))
      .catch(() => setPixelRecent(null))
      .finally(() => setPixelChecking(false));
  }

  // AIC-107: the objective step sets the destination directly — engagement
  // has no separate "where do leads arrive" question, because there are no
  // leads. Switching away clears the other branch's fields for the same
  // reason chooseDestination does.
  function chooseObjective(dest: string) {
    patch(dest === ENGAGEMENT_DESTINATION
      ? { destination: dest, whatsappNumber: "", destinationUrl: "", pixelId: "", conversionEvent: "" }
      : { destination: FIXED_DESTINATION });
    setPixelRecent(null);
  }

  const createdAds = ads.filter((a) => a.creativeId);
  const isWebsite = wizard.destination === WEBSITE_DESTINATION;
  const isEngagement = wizard.destination === ENGAGEMENT_DESTINATION;
  // AIC-107: engagement has no destination to validate — the interaction is
  // on the Page post itself, so this step has nothing to gate on.
  const destinationValid = isEngagement
    ? true
    : isWebsite
      ? /^https?:\/\/.+/.test(wizard.destinationUrl) && !!wizard.pixelId && !!wizard.conversionEvent
      : /^\d{6,15}$/.test(wizard.whatsappNumber);
  // Over the ceiling agreed with the customer at provisioning. Checked HERE,
  // at the field, instead of at build time — the server still enforces it
  // (assertCreateWithinBudget) because a client check is a convenience, never
  // the guarantee.
  const budgetOverCeiling =
    agreedBudgetAgorot !== null &&
    Number.isFinite(wizard.dailyBudgetShekels) &&
    Math.round(wizard.dailyBudgetShekels * 100) > agreedBudgetAgorot;

  const canNext = [
    true, // goal
    destinationValid,
    Number.isFinite(wizard.dailyBudgetShekels) && wizard.dailyBudgetShekels > 0 && !budgetOverCeiling,
    true, // special category
    wizard.ageMin >= 13 && wizard.ageMax > wizard.ageMin && wizard.ageMax <= 65,
    true, // placements
    createdAds.length >= 1,
    false, // review — handled by the create button, not "next"
  ][step];

  async function submit() {
    if (!wizard || !localCampaignId) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await buildCampaign({
        localCampaignId,
        // AIC-154: no name. The server derives it — this sent
        // strings.he.appName, which named every campaign "Ads Agent".
        dailyBudgetAgorot: Math.round(wizard.dailyBudgetShekels * 100),
        specialAdCategories: wizard.specialCategory === "NONE" ? [] : [wizard.specialCategory],
        destination: wizard.destination,
        whatsappDestination: isWebsite ? "" : wizard.whatsappNumber,
        destinationUrl: isWebsite ? wizard.destinationUrl : undefined,
        pixelId: isWebsite ? wizard.pixelId : undefined,
        conversionEvent: isWebsite ? wizard.conversionEvent : undefined,
        targeting: { ageMin: wizard.ageMin, ageMax: wizard.ageMax, genders: wizard.gender, cities: wizard.cities },
        ads: createdAds.map((a) => ({ clientKey: a.clientKey, name: a.name, creativeId: a.creativeId! })),
      }, customerId);
      setBuildResult(result);
      clearDraft(customerId); // the wizard's job is done — nothing left to resume
    } catch (e) {
      // "i want to see the error on the ui not a useless message." The admin
      // build route attaches `detail` (the real failure reason) — surface it
      // when present. Only the ADMIN route sends it, so a customer building
      // their own campaign still sees the friendly message alone.
      const detail = e instanceof ApiError
        ? (e.body as { detail?: string } | undefined)?.detail
        : undefined;
      const base = e instanceof ApiError ? e.message : rv.errorGeneric;
      setBuildError(detail ? `${base} — ${detail}` : base);
    } finally {
      setBuilding(false);
    }
  }

  if (buildResult) {
    return (
      <div className="wrap page" style={{ maxWidth: 640, marginInline: "auto" }}>
        <div className="card">
          <StatusPill variant="ok">✓</StatusPill>
          <b style={{ fontSize: "1.3rem", display: "block", margin: "14px 0 10px" }}>{rv.successTitle}</b>
          {/* Operator vs customer. `customerId` set means an operator built
              this on a customer's behalf, and `exit` returns them to the
              onboarding wizard — NOT to "/app". The copy used to say
              "למעבר לדף הראשי" ("go to the main page") in both cases, which
              is customer framing shown to an operator and gave no hint the
              button comes back here. Reported live 2026-08-23: "in the wizard
              step 5 there's a finish button, does it need to be clicked?" —
              the answer was invisible because the button did not say where it
              went. */}
          <p className="muted" style={{ marginBottom: 20 }}>
            {customerId ? rv.successBodyOperator : rv.successBody}
          </p>
          <button className="btn btn-primary" onClick={exit}>
            {customerId ? rv.backToWizard : rv.goHome}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap page">
      <div style={{ marginBottom: 24 }}>
        <div className="eyebrow">{b.eyebrow}</div>
        <h1 style={{ marginTop: 10 }}>{b.title}</h1>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <Stepper steps={b.stepNames} currentIndex={step} />
      </div>

      <div className="grid-2">
        <div className="card">
          {step === 0 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{g.title}</b>
              <p className="muted" style={{ margin: "12px 0" }}>{g.body}</p>
              <label style={{ display: "block", marginBottom: 8, fontSize: "0.9rem" }}>{g.objectiveLabel}</label>
              <div className="stack gap12">
                <label className="row gap12" style={{ alignItems: "flex-start", cursor: "pointer" }}>
                  <input
                    type="radio" name="objective" checked={!isEngagement}
                    onChange={() => chooseObjective(FIXED_DESTINATION)}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    {g.objectiveLeads}
                    <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>{g.objectiveLeadsHint}</span>
                  </span>
                  <Recommended />
                </label>
                <label className="row gap12" style={{ alignItems: "flex-start", cursor: "pointer" }}>
                  <input
                    type="radio" name="objective" checked={isEngagement}
                    onChange={() => chooseObjective(ENGAGEMENT_DESTINATION)}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    {g.objectiveEngagement}
                    <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>{g.objectiveEngagementHint}</span>
                  </span>
                </label>
              </div>
              {isEngagement && (
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>ℹ️ {g.objectiveEngagementLimits}</p>
              )}
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>{g.fixedNote}</p>
            </div>
          )}

          {step === 1 && isEngagement && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{ds.title}</b>
              {/* AIC-98: not a blank step — say why there is nothing to
                  choose, rather than rendering an empty panel. */}
              <p className="muted" style={{ margin: "12px 0" }}>{ds.engagementNoDestination}</p>
            </div>
          )}

          {step === 1 && !isEngagement && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{ds.title}</b>
              <p className="muted" style={{ margin: "12px 0" }}>{ds.body}</p>

              <div className="stack gap12" style={{ marginBottom: 16 }}>
                <label className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="destination" checked={!isWebsite} onChange={() => chooseDestination(FIXED_DESTINATION)} />
                  <span>{ds.optionWhatsapp}</span>
                  <Recommended />
                </label>
                <label className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="destination" checked={isWebsite} onChange={() => chooseDestination(WEBSITE_DESTINATION)} />
                  <span>{ds.optionWebsite}</span>
                </label>
              </div>

              {!isWebsite ? (
                <>
                  <p className="muted" style={{ marginBottom: 12 }}>{ds.whatsappBody}</p>
                  <div className="field">
                    <label>{ds.whatsappLabel}</label>
                    <input
                      type="tel" placeholder={ds.whatsappPlaceholder} value={wizard.whatsappNumber}
                      onChange={(e) => patch({ whatsappNumber: e.target.value.replace(/[^\d]/g, "") })}
                    />
                  </div>
                  {wizard.whatsappNumber && !canNext && <p className="muted" style={{ marginTop: 8 }}>{ds.whatsappInvalid}</p>}
                </>
              ) : (
                <>
                  <p className="muted" style={{ marginBottom: 12 }}>{ds.websiteBody}</p>
                  <div className="field">
                    <label>{ds.urlLabel}</label>
                    <input
                      type="url" placeholder={ds.urlPlaceholder} value={wizard.destinationUrl}
                      onChange={(e) => patch({ destinationUrl: e.target.value })}
                    />
                  </div>
                  {wizard.destinationUrl && !/^https?:\/\/.+/.test(wizard.destinationUrl) && (
                    <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>{ds.urlInvalid}</p>
                  )}

                  <div className="field" style={{ marginTop: 12 }}>
                    <label>{ds.pixelLabel}</label>
                    {pixelsLoading ? (
                      <p className="muted">{ds.pixelLoading}</p>
                    ) : pixels && pixels.length === 0 ? (
                      <p className="muted">{ds.pixelNone}</p>
                    ) : (
                      <select
                        value={wizard.pixelId}
                        onChange={(e) => { patch({ pixelId: e.target.value }); runPixelCheck(e.target.value, wizard.conversionEvent); }}
                      >
                        <option value="">{ds.pixelPlaceholder}</option>
                        {(pixels ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </div>

                  <div className="field" style={{ marginTop: 12 }}>
                    <label>{ds.eventLabel}</label>
                    <select
                      value={wizard.conversionEvent}
                      onChange={(e) => { patch({ conversionEvent: e.target.value }); runPixelCheck(wizard.pixelId, e.target.value); }}
                    >
                      <option value="">{ds.eventPlaceholder}</option>
                      {LEAD_CONVERSION_EVENTS.map((ev) => (
                        <option key={ev.value} value={ev.value}>{ds.eventOptions[ev.value] ?? ev.value}</option>
                      ))}
                    </select>
                  </div>

                  {pixelChecking && <p className="muted" style={{ marginTop: 10 }}>{ds.recencyChecking}</p>}
                  {!pixelChecking && pixelRecent === false && (
                    <p className="muted" style={{ marginTop: 10, color: "var(--orange)" }}>{ds.recencyWarning}</p>
                  )}
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="row between"><b style={{ fontSize: "1.2rem" }}>{bg.title}</b><Recommended /></div>
              <div className="field" style={{ marginTop: 12 }}>
                <label>{bg.label}</label>
                <input type="number" min={1} value={wizard.dailyBudgetShekels} onChange={(e) => patch({ dailyBudgetShekels: Number(e.target.value) })} />
              </div>
              {/* AIC-106 follow-up: the refusal belongs AT the field. Before
                  this, an over-ceiling number was accepted here and only
                  rejected on the wizard's final click, after every remaining
                  step had been filled in. */}
              {budgetOverCeiling && agreedBudgetAgorot !== null && (
                <p style={{ marginTop: 10, color: "#c0362c" }}>
                  {bg.overCeiling.replace("{max}", String(Math.floor(agreedBudgetAgorot / 100)))}
                </p>
              )}
              <p className="muted" style={{ marginTop: 12 }}>{bg.rationale}</p>
            </div>
          )}

          {step === 3 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{sc.title}</b>
              <p className="muted" style={{ margin: "12px 0" }}>{sc.question}</p>
              <div className="stack gap12">
                {SPECIAL_AD_CATEGORY.map((opt) => (
                  <label key={opt} className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="special-category" checked={wizard.specialCategory === opt} onChange={() => patch({ specialCategory: opt })} />
                    <span>{sc.options[opt]}</span>
                    {opt === RECOMMENDED_SPECIAL_AD_CATEGORY && <Recommended />}
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <AudienceFields
              category={category}
              value={{ ageMin: wizard.ageMin, ageMax: wizard.ageMax, gender: wizard.gender, cities: wizard.cities }}
              onCategoryChange={setCategory}
              onChange={patch}
              customerId={customerId}
            />
          )}

          {step === 5 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{pl.title}</b>
              <p className="muted" style={{ marginTop: 12 }}>{pl.body}</p>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>{pl.fixedNote}</p>
            </div>
          )}

          {step === 6 && (
            <div>
              <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 12 }}>{b.creatives.title}</b>
              <BuilderCreatives
                businessName={page.name ?? undefined}
                pagePictureUrl={page.pictureUrl}
                ads={ads} onChange={setAds} localCampaignId={localCampaignId} customerId={customerId} postsOnly={isEngagement}
                whatsappCampaign={!isWebsite && !isEngagement}
                whatsappNumber={isWebsite ? undefined : wizard.whatsappNumber}
                destination={isWebsite ? wizard.destination : undefined}
                destinationUrl={isWebsite ? wizard.destinationUrl : undefined}
              />
            </div>
          )}

          {step === 7 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{rv.title}</b>
              <p className="muted" style={{ margin: "12px 0 20px" }}>{rv.body}</p>
              <div className="summary-row">
                <span className="k">{rv.destinationLine}</span>
                <b>{isWebsite ? wizard.destinationUrl : wizard.whatsappNumber}</b>
              </div>
              <div className="summary-row"><span className="k">{rv.budgetLine}</span><b>₪{wizard.dailyBudgetShekels}</b></div>
              <div className="summary-row"><span className="k">{rv.businessLine}</span><b>{au.businessTypes[category]}</b></div>
              <div className="summary-row"><span className="k">{rv.audienceLine}</span><b>{wizard.ageMin}–{wizard.ageMax}, {au.genderOptions[wizard.gender]} · <bdi>{geoSummary(wizard.cities)}</bdi></b></div>
              <div className="summary-row"><span className="k">{rv.placementsLine}</span><b>{rv.placementsValue}</b></div>
              <div className="summary-row"><span className="k">{rv.adsLine}</span><b>{createdAds.length}</b></div>
              {/* AIC-106 — the launch gate is gone, so this is the last thing
                  seen before money moves. It names the customer explicitly
                  because that is the one error the gate used to catch: a
                  correctly-typed budget against the wrong customer. */}
              <div
                className="card"
                style={{ marginTop: 18, background: "var(--warn-bg, #fff8e6)", borderColor: "var(--warn-border, #e8c766)" }}
              >
                <b style={{ display: "block", marginBottom: 8 }}>{rv.confirmTitle}</b>
                <p style={{ margin: "0 0 6px" }}>
                  {rv.confirmFor} <b>{businessName || "—"}</b> · <b>₪{wizard.dailyBudgetShekels}</b> {rv.confirmPerDay}
                </p>
                <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>{rv.confirmStartsNow}</p>
              </div>
              {buildError && <p className="muted" style={{ marginTop: 16, color: "var(--orange)" }}>{buildError}</p>}
              <button className="btn btn-primary btn-wide" style={{ marginTop: 20 }} disabled={building || createdAds.length === 0} onClick={submit}>
                {building ? rv.creating : rv.createCta}
              </button>
            </div>
          )}

          {step < 7 && (
            <div className="row gap12" style={{ marginTop: 24 }}>
              {step > 0 && <button className="btn btn-outline btn-sm" onClick={() => setStep((s) => s - 1)}>{b.back}</button>}
              <button className="btn btn-primary btn-sm" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>{b.next}</button>
            </div>
          )}
          {step === 7 && step > 0 && (
            <div className="row gap12" style={{ marginTop: 16 }}>
              <button className="btn btn-outline btn-sm" onClick={() => setStep((s) => s - 1)}>{b.back}</button>
            </div>
          )}
        </div>
        {!customerId && <SupportCard />}
      </div>
    </div>
  );
}
