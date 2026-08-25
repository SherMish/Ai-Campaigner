import React from "react";
import { strings } from "../strings";
import type { CustomerWriteFields } from "../api";

const cc = strings.he.customerCrud;

// The business profile a customer is described by. Extracted from
// AdminCustomers (AIC-134) so the onboarding wizard can collect the SAME set
// rather than grow a parallel copy — a second list of these fields would drift
// the first time one is added, and the drifting half would be the one an
// operator fills in during a live call.
export const EMPTY_BUSINESS_FORM: CustomerWriteFields = {
  businessName: "", category: "", mainService: "", geoArea: "", primaryCustomer: "",
  offer: "", contactName: "", contactPhone: "", contactEmail: "", isTest: false,
};

export function BusinessFields({
  form, onChange, showIsTest = true,
}: {
  form: CustomerWriteFields;
  onChange: (f: CustomerWriteFields) => void;
  showIsTest?: boolean;
}) {
  const set = (k: keyof CustomerWriteFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...form, [k]: e.target.value });
  return (
    <div className="op-form-grid">
      <div className="field span-2"><label>{cc.fieldBusinessName}</label><input value={form.businessName ?? ""} onChange={set("businessName")} required /></div>
      <div className="field"><label>{cc.fieldCategory}</label><input value={form.category ?? ""} onChange={set("category")} /></div>
      <div className="field"><label>{cc.fieldMainService}</label><input value={form.mainService ?? ""} onChange={set("mainService")} /></div>
      <div className="field"><label>{cc.fieldGeoArea}</label><input value={form.geoArea ?? ""} onChange={set("geoArea")} /></div>
      <div className="field"><label>{cc.fieldPrimaryCustomer}</label><input value={form.primaryCustomer ?? ""} onChange={set("primaryCustomer")} /></div>
      <div className="field span-2"><label>{cc.fieldOffer}</label><input value={form.offer ?? ""} onChange={set("offer")} /></div>
      <div className="field"><label>{cc.fieldContactName}</label><input value={form.contactName ?? ""} onChange={set("contactName")} /></div>
      <div className="field"><label>{cc.fieldContactPhone}</label><input value={form.contactPhone ?? ""} onChange={set("contactPhone")} /></div>
      <div className="field span-2"><label>{cc.fieldContactEmail}</label><input type="email" value={form.contactEmail ?? ""} onChange={set("contactEmail")} /></div>
      {showIsTest && (
        <label className="check span-2">
          <input type="checkbox" checked={form.isTest ?? false} onChange={(e) => onChange({ ...form, isTest: e.target.checked })} />
          {cc.fieldIsTest}
        </label>
      )}
    </div>
  );
}
