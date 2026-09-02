import { useEffect, useRef, useState } from "react";
import { BUSINESS_CATEGORY, PLACEMENT, resolveAudienceDefault, type BusinessCategory, type Placement } from "@aic/shared";
import { placementBlocker, placementFallback } from "./placement-gate";
import { searchGeoPlaces, type GeoPlace } from "../api";
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
  // AIC-157 — where the ads run. Empty means all of Israel, which is what
  // every ad set we had ever created targeted, because no screen offered the
  // choice. It lives on the SHARED audience value so the builder and
  // add-content cannot end up with different targeting powers.
  cities: GeoPlace[];
  // AIC-177 — where the ads may run. Same reasoning as `cities` above: it
  // lives on the SHARED audience value so the builder and add-content cannot
  // end up offering different placement powers.
  placement: Placement;
}

const b = strings.he.builder;
const au = b.audience;

interface Props {
  category: BusinessCategory;
  value: AudienceValue;
  onCategoryChange: (cat: BusinessCategory) => void;
  onChange: (patch: Partial<AudienceValue>) => void;
  /** Present when an operator is driving this for a customer — the geo lookup
   *  routes through the admin path then, same as every other builder read. */
  customerId?: string;
  /** AIC-177 — decides whether the Instagram-only option is choosable. */
  hasInstagram: boolean;
}

export function AudienceFields({ category, value, onCategoryChange, onChange, customerId, hasInstagram }: Props) {
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
      <GeoPicker
        selected={value.cities}
        onChange={(cities) => onChange({ cities })}
        customerId={customerId}
      />
      <PlacementPicker
        value={value.placement}
        hasInstagram={hasInstagram}
        onChange={(placement) => onChange({ placement })}
      />
      <p className="muted" style={{ marginTop: 12 }}>{au.categoryRationale[category]}</p>
    </div>
  );
}


/*
 * Where the ads run (AIC-177).
 *
 * Advantage+ is the default AND the recommendation, which is not a hedge: Meta
 * moves budget to whatever converts, and an SMB has no basis to beat it. Every
 * ad set we ever created already ran this way — the difference is that it is
 * now a choice someone made rather than the absence of a control, which is
 * exactly what AIC-157 fixed for geo.
 *
 * An unavailable option is rendered DISABLED WITH ITS REASON BESIDE IT, never
 * hidden and never silently inert. Hiding it would leave a customer who
 * expects Instagram wondering where it went; leaving it clickable-but-dead is
 * the AIC-173 failure. The reason names the fix.
 */
function PlacementPicker({ value, hasInstagram, onChange }: {
  value: Placement;
  hasInstagram: boolean;
  onChange: (p: Placement) => void;
}) {
  // A held choice that became unavailable is corrected on sight rather than at
  // submit time, where the server's refusal would name something the customer
  // cannot see from this screen.
  useEffect(() => {
    const fallback = placementFallback(value, { hasInstagram });
    if (fallback) onChange(fallback);
  }, [value, hasInstagram, onChange]);

  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>{au.placementLabel}</label>
      <div className="stack gap8" style={{ marginTop: 6 }}>
        {PLACEMENT.map((p) => {
          const blocked = placementBlocker(p, { hasInstagram });
          return (
            <label
              key={p}
              className="row gap8"
              style={{ alignItems: "flex-start", opacity: blocked ? 0.55 : 1, cursor: blocked ? "not-allowed" : "pointer" }}
            >
              <input
                type="radio"
                name="placement"
                value={p}
                checked={value === p}
                disabled={!!blocked}
                onChange={() => onChange(p)}
                style={{ marginTop: 4 }}
              />
              <span>
                <b>{au.placementOptions[p]}</b>
                <span className="muted" style={{ display: "block", fontSize: "0.82rem" }}>
                  {blocked ? au.placementBlocked[blocked] : au.placementHints[p]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/*
 * The location picker (AIC-157).
 *
 * Type-ahead against Meta's own adgeolocation search rather than a list we
 * maintain: the only value Meta will actually target on is its `key`, so a
 * name we transcribe is not a targetable thing at all. Hebrew queries work and
 * come back English; the server localizes before we see them.
 *
 * Selecting nothing is a legitimate answer — nationwide — so this never blocks
 * the step. What it does is stop nationwide from being the silent default: the
 * empty state SAYS "כל ישראל" and says why that is usually wrong for a local
 * business, which is the one thing the old geoNote got right and the reason
 * this replaces it rather than sitting beside it.
 */
function GeoPicker({ selected, onChange, customerId }: {
  selected: GeoPlace[];
  onChange: (next: GeoPlace[]) => void;
  customerId?: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoPlace[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Every keystroke would be a live Meta call. The ref holds the latest query
  // so a slow response for "רמ" can never overwrite the results for "רמת גן".
  const latest = useRef("");

  useEffect(() => {
    const term = q.trim();
    latest.current = term;
    if (term.length < 2) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchGeoPlaces(term, customerId)
        .then((r) => { if (latest.current === term) setResults(r.places); })
        .catch(() => { if (latest.current === term) setResults([]); })
        .finally(() => { if (latest.current === term) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q, customerId]);

  function add(p: GeoPlace) {
    if (!selected.some((s) => s.key === p.key)) onChange([...selected, p]);
    setQ("");
    setResults(null);
  }

  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>{au.geoLabel}</label>
      <input type="text" value={q} placeholder={au.geoPlaceholder} onChange={(e) => setQ(e.target.value)} />

      {searching && <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{au.geoSearching}</p>}

      {!searching && results?.length === 0 && (
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{au.geoNoResults}</p>
      )}

      {!searching && !!results?.length && (
        <div className="geo-results">
          {results.map((p) => (
            <button key={p.key} type="button" className="geo-result" onClick={() => add(p)}>
              {/* The district disambiguates two towns sharing a name — the
                  difference between the right one and finding out from the
                  spend. */}
              <bdi>{p.name}</bdi>
              {p.region && p.region !== p.name && <span className="muted"> · {p.region}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="geo-chips">
        {selected.length === 0 ? (
          <span className="muted" style={{ fontSize: "0.82rem" }}>{au.geoAllIsrael}</span>
        ) : (
          selected.map((p) => (
            <span key={p.key} className="geo-chip">
              <bdi>{p.name}</bdi>
              <button
                type="button"
                aria-label={au.geoRemove}
                onClick={() => onChange(selected.filter((s) => s.key !== p.key))}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <span className="muted" style={{ fontSize: "0.82rem" }}>{au.geoHint}</span>
    </div>
  );
}
