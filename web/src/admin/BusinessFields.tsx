import { useRef, type ReactNode } from "react";
import { strings } from "../strings";
import type { CustomerWriteFields } from "../api";
import { InfoTip } from "../app/InfoTip";

const cc = strings.he.customerCrud;
const hint = cc.hints;

// The business profile a customer is described by. Extracted from
// AdminCustomers (AIC-134) so the onboarding wizard collects the SAME set
// rather than growing a parallel copy — a second list of these fields would
// drift the first time one was added, and the drifting half would be the one an
// operator fills in during a live call.
export const EMPTY_BUSINESS_FORM: CustomerWriteFields = {
  businessName: "", category: "", mainService: "", geoArea: "", primaryCustomer: "",
  offer: "", differentiators: "", objections: "", priceRange: "", copyConstraints: "",
  leadFollowup: "", contactName: "", contactPhone: "", contactEmail: "", isTest: false,
};

// Every label carries its own "i". The value of these answers depends entirely
// on HOW they are filled in — "שיפוצים" and "שיפוצי מטבחים בדירות ישנות בגוש
// דן" are the same field and produce completely different ad copy — so the
// hint is not decoration, it is the difference between a usable answer and a
// worthless one. Sits next to the label rather than under it so the form keeps
// its shape and the operator can scan past the ones they already know.

// DEFINED AT MODULE LEVEL, and that is load-bearing rather than style.
//
// These started life inside BusinessFields, which gives them a NEW component
// identity on every render — so React unmounted and remounted each input on
// every keystroke. Caught in the browser before shipping: the DOM node was
// replaced (`sameNode: false`) and focus went to <body>, meaning an operator
// would type one character into "התנגדויות נפוצות" and be thrown out of the
// field. The form would have been unusable, and nothing in typecheck, build or
// any test would have said a word.
function Field({ label, tip, children }: { label: string; tip: string; children: ReactNode }) {
  return (
    <>
      <label className="row gap8" style={{ alignItems: "center" }}>
        <span>{label}</span>
        <InfoTip label={label}>
          <p style={{ margin: 0, fontSize: "0.85rem" }}>{tip}</p>
        </InfoTip>
      </label>
      {children}
    </>
  );
}

function TextField({ value, onChange, label, tip, span, required, type }: {
  value: string; onChange: (v: string) => void; label: string; tip: string;
  span?: boolean; required?: boolean; type?: string;
}) {
  return (
    <div className={span ? "field span-2" : "field"}>
      <Field label={label} tip={tip}>
        <input type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}

// The creative-context answers are sentences, not words — a single-line input
// invites a two-word reply, which is exactly the useless version of these
// fields. The taller box is the prompt.
function AreaField({ value, onChange, label, tip }: {
  value: string; onChange: (v: string) => void; label: string; tip: string;
}) {
  return (
    <div className="field span-2">
      <Field label={label} tip={tip}>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} style={{ minHeight: 64 }} />
      </Field>
    </div>
  );
}

export function BusinessFields({
  form, onChange, showIsTest = true,
}: {
  form: CustomerWriteFields;
  onChange: (f: CustomerWriteFields) => void;
  showIsTest?: boolean;
}) {
  // `form` is a PROP, captured at render, so two edits landing in the same
  // tick would both build from the same stale object and one would be lost.
  // Reachable in practice: browser/password-manager autofill sets name, phone
  // and email together, and typing is only safe because each keystroke is its
  // own tick.
  //
  // Composing through a ref makes sequential edits build on each other. This is
  // the same fix BuilderCreatives needed this morning ("the photo appears for 1
  // sec and disappears") — written the same way on purpose, because the two
  // components share the shape and the next one to grow it should find a
  // precedent rather than rediscover the bug.
  const latest = useRef(form);
  latest.current = form;
  const patch = (p: Partial<CustomerWriteFields>) => {
    const next = { ...latest.current, ...p };
    latest.current = next;
    onChange(next);
  };

  const val = (k: keyof CustomerWriteFields) => (form[k] as string) ?? "";
  const on = (k: keyof CustomerWriteFields) => (v: string) => patch({ [k]: v });

  return (
    <div className="op-form-grid">
      <TextField label={cc.fieldBusinessName} tip={hint.businessName} value={val("businessName")} onChange={on("businessName")} span required />
      <TextField label={cc.fieldCategory} tip={hint.category} value={val("category")} onChange={on("category")} />
      <TextField label={cc.fieldMainService} tip={hint.mainService} value={val("mainService")} onChange={on("mainService")} />
      <TextField label={cc.fieldGeoArea} tip={hint.geoArea} value={val("geoArea")} onChange={on("geoArea")} />
      <TextField label={cc.fieldPrimaryCustomer} tip={hint.primaryCustomer} value={val("primaryCustomer")} onChange={on("primaryCustomer")} />
      <AreaField label={cc.fieldOffer} tip={hint.offer} value={val("offer")} onChange={on("offer")} />

      {/* AIC-78's creative context. Grouped after the basics because they are
          the answers a founder gives once, unprompted, in the first minutes of
          a call — and the ones with nowhere to live until now. */}
      <AreaField label={cc.fieldDifferentiators} tip={hint.differentiators} value={val("differentiators")} onChange={on("differentiators")} />
      <AreaField label={cc.fieldObjections} tip={hint.objections} value={val("objections")} onChange={on("objections")} />
      <TextField label={cc.fieldPriceRange} tip={hint.priceRange} value={val("priceRange")} onChange={on("priceRange")} />
      <TextField label={cc.fieldLeadFollowup} tip={hint.leadFollowup} value={val("leadFollowup")} onChange={on("leadFollowup")} />
      <AreaField label={cc.fieldCopyConstraints} tip={hint.copyConstraints} value={val("copyConstraints")} onChange={on("copyConstraints")} />

      <TextField label={cc.fieldContactName} tip={hint.contactName} value={val("contactName")} onChange={on("contactName")} />
      <TextField label={cc.fieldContactPhone} tip={hint.contactPhone} value={val("contactPhone")} onChange={on("contactPhone")} />
      <TextField label={cc.fieldContactEmail} tip={hint.contactEmail} value={val("contactEmail")} onChange={on("contactEmail")} span type="email" />

      {showIsTest && (
        <label className="check span-2 row gap8" style={{ alignItems: "center" }}>
          <input type="checkbox" checked={form.isTest ?? false} onChange={(e) => patch({ isTest: e.target.checked })} />
          <span>{cc.fieldIsTest}</span>
          <InfoTip label={cc.fieldIsTest}>
            <p style={{ margin: 0, fontSize: "0.85rem" }}>{hint.isTest}</p>
          </InfoTip>
        </label>
      )}
    </div>
  );
}
