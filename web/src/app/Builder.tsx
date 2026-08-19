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
  getBuilderContext, startBuilder, buildCampaign, getBuilderPixels, checkBuilderPixel, ApiError,
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

export function Builder({ customerId, onExit }: Props = {}) {
  const nav = useNavigate();
  const exit = onExit ?? (() => nav("/app"));
  const [phase, setPhase] = useState<"loading" | "not_ready" | "ready" | "error">("loading");
  const [category, setCategory] = useState<BusinessCategory>("other");
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
        const aud = resolveAudienceDefault(cat);
        setWizard({
          destination: FIXED_DESTINATION,
          whatsappNumber: "",
          destinationUrl: "",
          pixelId: "",
          conversionEvent: "",
          dailyBudgetShekels: RECOMMENDED_BUDGET_AGOROT_PER_DAY.recommended / 100,
          specialCategory: RECOMMENDED_SPECIAL_AD_CATEGORY,
          ageMin: aud.ageMin, ageMax: aud.ageMax, gender: aud.genders,
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
    setWizard((prev) => (prev ? { ...prev, ...p } : prev));
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
  const canNext = [
    true, // goal
    destinationValid,
    Number.isFinite(wizard.dailyBudgetShekels) && wizard.dailyBudgetShekels > 0,
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
        name: strings.he.appName,
        dailyBudgetAgorot: Math.round(wizard.dailyBudgetShekels * 100),
        specialAdCategories: wizard.specialCategory === "NONE" ? [] : [wizard.specialCategory],
        destination: wizard.destination,
        whatsappDestination: isWebsite ? "" : wizard.whatsappNumber,
        destinationUrl: isWebsite ? wizard.destinationUrl : undefined,
        pixelId: isWebsite ? wizard.pixelId : undefined,
        conversionEvent: isWebsite ? wizard.conversionEvent : undefined,
        targeting: { ageMin: wizard.ageMin, ageMax: wizard.ageMax, genders: wizard.gender },
        ads: createdAds.map((a) => ({ clientKey: a.clientKey, name: a.name, creativeId: a.creativeId! })),
      }, customerId);
      setBuildResult(result);
    } catch (e) {
      setBuildError(e instanceof ApiError ? e.message : rv.errorGeneric);
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
          <p className="muted" style={{ marginBottom: 20 }}>{rv.successBody}</p>
          <button className="btn btn-primary" onClick={exit}>{rv.goHome}</button>
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
              value={{ ageMin: wizard.ageMin, ageMax: wizard.ageMax, gender: wizard.gender }}
              onCategoryChange={setCategory}
              onChange={patch}
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
                ads={ads} onChange={setAds} localCampaignId={localCampaignId} customerId={customerId} postsOnly={isEngagement}
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
              <div className="summary-row"><span className="k">{rv.audienceLine}</span><b>{wizard.ageMin}–{wizard.ageMax}, {au.genderOptions[wizard.gender]} · {rv.geoValue}</b></div>
              <div className="summary-row"><span className="k">{rv.placementsLine}</span><b>{rv.placementsValue}</b></div>
              <div className="summary-row"><span className="k">{rv.adsLine}</span><b>{createdAds.length}</b></div>
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
