import { BUSINESS_CATEGORY, resolveAudienceDefault, type BusinessCategory } from "@aic/shared";
import { strings } from "../strings";
import { Recommended } from "./components";

// Shared between Builder.tsx (first-campaign audience step) and AddContent.tsx
// (AIC-63's add-ad-set audience step) — extracted so the honesty-pass fix
// (business type visible + editable, no dead radius control) only needs to
// exist once. See docs/features/campaign-builder.md for why this shape.

export type Gender = "all" | "male" | "female";
export interface AudienceValue {
  ageMin: number;
  ageMax: number;
  gender: Gender;
}

const b = strings.he.builder;
const au = b.audience;

interface Props {
  category: BusinessCategory;
  value: AudienceValue;
  onCategoryChange: (cat: BusinessCategory) => void;
  onChange: (patch: Partial<AudienceValue>) => void;
}

export function AudienceFields({ category, value, onCategoryChange, onChange }: Props) {
  return (
    <div>
      <div className="row between"><b style={{ fontSize: "1.2rem" }}>{au.title}</b><Recommended /></div>
      {/* Business type — the input driving the whole recommendation. Shown +
          editable so the assumption is visible and correctable. */}
      <div className="field" style={{ marginTop: 12 }}>
        <label>{au.businessTypeLabel}</label>
        <select
          value={category}
          onChange={(e) => {
            const cat = e.target.value as BusinessCategory;
            onCategoryChange(cat);
            const d = resolveAudienceDefault(cat);
            onChange({ ageMin: d.ageMin, ageMax: d.ageMax, gender: d.genders });
          }}
        >
          {BUSINESS_CATEGORY.map((c) => (
            <option key={c} value={c}>{au.businessTypes[c]}</option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: "0.82rem" }}>{au.businessTypeHint}</span>
      </div>
      <div className="field-row" style={{ marginTop: 12 }}>
        <div className="field"><label>{au.ageMinLabel}</label><input type="number" min={13} max={65} value={value.ageMin} onChange={(e) => onChange({ ageMin: Number(e.target.value) })} /></div>
        <div className="field"><label>{au.ageMaxLabel}</label><input type="number" min={13} max={65} value={value.ageMax} onChange={(e) => onChange({ ageMax: Number(e.target.value) })} /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label>{au.genderLabel}</label>
        <select value={value.gender} onChange={(e) => onChange({ gender: e.target.value as Gender })}>
          <option value="all">{au.genderOptions.all}</option>
          <option value="male">{au.genderOptions.male}</option>
          <option value="female">{au.genderOptions.female}</option>
        </select>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>{au.categoryRationale[category]}</p>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>{au.geoNote}</p>
    </div>
  );
}
