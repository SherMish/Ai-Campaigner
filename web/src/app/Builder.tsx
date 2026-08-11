import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  RECOMMENDED_BUDGET_AGOROT_PER_DAY, RECOMMENDED_SPECIAL_AD_CATEGORY,
  SPECIAL_AD_CATEGORY, resolveAudienceDefault, normalizeBusinessCategory, type SpecialAdCategory,
} from "@aic/shared";
import { strings } from "../strings";
import {
  getBuilderContext, startBuilder, buildCampaign, ApiError,
  type BuildCampaignResult,
} from "../api";
import { Stepper, StatusPill, SupportCard } from "./components";
import { BuilderCreatives, newAdDraft, type AdDraft } from "./BuilderCreatives";

const b = strings.he.builder;
const g = b.goal, w = b.whatsapp, bg = b.budget, sc = b.specialCategory, au = b.audience, pl = b.placements, rv = b.review;

type Gender = "all" | "male" | "female";

interface WizardState {
  whatsappNumber: string;
  dailyBudgetShekels: number;
  specialCategory: SpecialAdCategory;
  ageMin: number;
  ageMax: number;
  gender: Gender;
  radiusKm: number;
}

function Recommended() {
  return <StatusPill variant="ok">✓ {b.recommended}</StatusPill>;
}

export function Builder() {
  const nav = useNavigate();
  const [phase, setPhase] = useState<"loading" | "not_ready" | "ready" | "error">("loading");
  const [category, setCategory] = useState("");
  const [localCampaignId, setLocalCampaignId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [ads, setAds] = useState<AdDraft[]>([newAdDraft(1), newAdDraft(2), newAdDraft(3)]);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildCampaignResult | null>(null);

  useEffect(() => {
    getBuilderContext()
      .then((ctx) => {
        setCategory(ctx.category);
        const d = resolveAudienceDefault(ctx.category);
        setWizard({
          whatsappNumber: "",
          dailyBudgetShekels: RECOMMENDED_BUDGET_AGOROT_PER_DAY.recommended / 100,
          specialCategory: RECOMMENDED_SPECIAL_AD_CATEGORY,
          ageMin: d.ageMin, ageMax: d.ageMax, gender: d.genders, radiusKm: d.radiusKm,
        });
        return startBuilder();
      })
      .then((r) => { setLocalCampaignId(r.localCampaignId); setPhase("ready"); })
      .catch((e) => setPhase(e instanceof ApiError && e.status === 409 ? "not_ready" : "error"));
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
          <button className="btn btn-primary btn-sm" onClick={() => nav("/app")}>{b.backToAccount}</button>
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

  const createdAds = ads.filter((a) => a.creativeId);
  const canNext = [
    true, // goal
    /^\d{6,15}$/.test(wizard.whatsappNumber),
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
        whatsappDestination: wizard.whatsappNumber,
        targeting: { ageMin: wizard.ageMin, ageMax: wizard.ageMax, genders: wizard.gender },
        ads: createdAds.map((a) => ({ clientKey: a.clientKey, name: a.name, creativeId: a.creativeId! })),
      });
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
          <button className="btn btn-primary" onClick={() => nav("/app")}>{rv.goHome}</button>
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
              <div className="field"><label>{g.objectiveLabel}</label><input type="text" value={g.objectiveValue} disabled /></div>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>{g.fixedNote}</p>
            </div>
          )}

          {step === 1 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{w.title}</b>
              <p className="muted" style={{ margin: "12px 0" }}>{w.body}</p>
              <div className="field">
                <label>{w.label}</label>
                <input type="tel" placeholder={w.placeholder} value={wizard.whatsappNumber} onChange={(e) => patch({ whatsappNumber: e.target.value.replace(/[^\d]/g, "") })} />
              </div>
              {wizard.whatsappNumber && !canNext && <p className="muted" style={{ marginTop: 8 }}>{w.invalid}</p>}
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
            <div>
              <div className="row between"><b style={{ fontSize: "1.2rem" }}>{au.title}</b><Recommended /></div>
              <div className="field-row" style={{ marginTop: 12 }}>
                <div className="field"><label>{au.ageMinLabel}</label><input type="number" min={13} max={65} value={wizard.ageMin} onChange={(e) => patch({ ageMin: Number(e.target.value) })} /></div>
                <div className="field"><label>{au.ageMaxLabel}</label><input type="number" min={13} max={65} value={wizard.ageMax} onChange={(e) => patch({ ageMax: Number(e.target.value) })} /></div>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label>{au.genderLabel}</label>
                <select value={wizard.gender} onChange={(e) => patch({ gender: e.target.value as Gender })}>
                  <option value="all">{au.genderOptions.all}</option>
                  <option value="male">{au.genderOptions.male}</option>
                  <option value="female">{au.genderOptions.female}</option>
                </select>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label>{au.radiusLabel}</label>
                <input type="number" min={1} value={wizard.radiusKm} onChange={(e) => patch({ radiusKm: Number(e.target.value) })} />
              </div>
              <p className="muted" style={{ marginTop: 12 }}>{au.categoryRationale[normalizeBusinessCategory(category)]}</p>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>{au.radiusNote}</p>
            </div>
          )}

          {step === 5 && (
            <div>
              <div className="row between"><b style={{ fontSize: "1.2rem" }}>{pl.title}</b><Recommended /></div>
              <p className="muted" style={{ marginTop: 12 }}>{pl.body}</p>
              <p className="muted" style={{ marginTop: 12 }}>{pl.rationale}</p>
            </div>
          )}

          {step === 6 && (
            <div>
              <b style={{ fontSize: "1.2rem", display: "block", marginBottom: 12 }}>{b.creatives.title}</b>
              <BuilderCreatives ads={ads} onChange={setAds} localCampaignId={localCampaignId} whatsappNumber={wizard.whatsappNumber} />
            </div>
          )}

          {step === 7 && (
            <div>
              <b style={{ fontSize: "1.2rem" }}>{rv.title}</b>
              <p className="muted" style={{ margin: "12px 0 20px" }}>{rv.body}</p>
              <div className="summary-row"><span className="k">{rv.whatsappLine}</span><b>{wizard.whatsappNumber}</b></div>
              <div className="summary-row"><span className="k">{rv.budgetLine}</span><b>₪{wizard.dailyBudgetShekels}</b></div>
              <div className="summary-row"><span className="k">{rv.audienceLine}</span><b>{wizard.ageMin}–{wizard.ageMax}, {au.genderOptions[wizard.gender]}</b></div>
              <div className="summary-row"><span className="k">{rv.placementsLine}</span><b>Advantage+</b></div>
              <div className="summary-row"><span className="k">{rv.adsLine}</span><b>{createdAds.length}</b></div>
              {buildError && <p className="muted" style={{ marginTop: 16, color: "var(--orange)" }}>{buildError}</p>}
              <button className="btn btn-primary" style={{ marginTop: 20 }} disabled={building || createdAds.length === 0} onClick={submit}>
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
        <SupportCard />
      </div>
    </div>
  );
}
