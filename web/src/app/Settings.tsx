import { useEffect, useState } from "react";
import { strings, connectionMessage } from "../strings";
import {
  shekels, recheckConnection, requestBudgetChange, changePassword,
  ApiError, type AccessHealth,
  adAccountLabel,
  getMyProfile, saveMyProfile, type CustomerWriteFields,
} from "../api";
import { StatusPill, SupportCard, Field, WA } from "./components";
import { BusinessFields } from "../admin/BusinessFields";
import { useSharedOverview } from "./overview-store";

const a = strings.he.app;
const s = a.settings;
const L = a.home.live;

export function Settings() {
  const { data: ov, loading, error: err, reload } = useSharedOverview(); // shared with Sidebar/Home (AIC-42)

  // action state
  const [budgetSent, setBudgetSent] = useState(false);
  const [connHealth, setConnHealth] = useState<AccessHealth | null>(null);
  const [connChecking, setConnChecking] = useState(false);
  // AIC-138: the business profile. `null` until loaded so the inputs are never
  // briefly blank and then filled — that reads as the page losing their data.
  const [profile, setProfile] = useState<CustomerWriteFields | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<"saved" | "error" | null>(null);

  useEffect(() => {
    getMyProfile().then(setProfile).catch(() => {});
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      await saveMyProfile(profile);
      setProfileMsg("saved");
    } catch {
      setProfileMsg("error");
    } finally {
      setProfileBusy(false);
    }
  }

  const period = ov?.campaign?.budgetPeriod === "monthly" ? L.perMonth : L.perDay;
  const conn = ov?.connection;
  const health = connectionMessage(connHealth ?? conn?.accessHealth ?? "needs_reconnect");
  const sub = ov?.subscription;

  function checkConnection() {
    setConnChecking(true);
    recheckConnection()
      .then((r) => setConnHealth(r.accessHealth))
      .catch(() => {})
      .finally(() => setConnChecking(false));
  }

  return (
    <div>
      <div className="wrap page dash" style={{ maxWidth: 820, marginInline: "auto" }}>
        <h1 className="dash-title">{s.title}</h1>

        {loading && !ov ? (
          <p className="muted">{a.loading}</p>
        ) : err || !ov ? (
          <div className="card">
            <p className="muted" style={{ marginBottom: 12 }}>{a.loadError}</p>
            <button className="btn btn-outline btn-sm" onClick={reload}>{a.retry}</button>
          </div>
        ) : (
          <div className="stack gap20" style={{ gap: 20 }}>
            <SupportCard />

            {/* AIC-138: the same fields the ops console collects, editable
                here. The customer is the authority on their own business, and
                a differentiator or a price changes without anyone thinking to
                tell their agency. Same component as the admin form, not a
                copy — with the internal test flag hidden, and the server
                whitelisting columns so it isn't reachable by posting it. */}
            {profile && (
              <div className="card">
                <b style={{ fontSize: "1.05rem", display: "block", marginBottom: 4 }}>{s.profileTitle}</b>
                <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 14 }}>{s.profileNote}</p>
                <form onSubmit={saveProfile}>
                  <BusinessFields form={profile} onChange={setProfile} showIsTest={false} />
                  <div className="row gap12" style={{ marginTop: 14, alignItems: "center" }}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={profileBusy}>
                      {profileBusy ? s.profileSaving : s.profileSave}
                    </button>
                    {profileMsg === "saved" && <span className="muted" style={{ color: "var(--green)", fontSize: "0.85rem" }}>{s.profileSaved}</span>}
                    {profileMsg === "error" && <span style={{ color: "var(--orange)", fontSize: "0.85rem" }}>{s.profileError}</span>}
                  </div>
                </form>
              </div>
            )}

            {/* budget */}
            <div className="card">
              <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
                <div>
                  <b style={{ fontSize: "1.1rem" }}>{s.budgetTitle}</b>
                  <p className="muted" style={{ marginTop: 6 }}>{s.budgetNote}</p>
                </div>
                <div className="row gap16">
                  <b style={{ fontSize: "1.4rem" }}>
                    {ov.campaign ? shekels(ov.campaign.liveBudgetAgorot ?? ov.campaign.agreedBudgetAgorot) : L.none}{" "}
                    <span className="muted" style={{ fontSize: "0.9rem", fontWeight: 400 }}>{period}</span>
                  </b>
                  {budgetSent ? (
                    <StatusPill variant="ok">✓</StatusPill>
                  ) : (
                    <button className="btn btn-outline btn-sm" onClick={() => requestBudgetChange().then(() => setBudgetSent(true)).catch(() => {})}>{s.budgetReq}</button>
                  )}
                </div>
              </div>
              {budgetSent && <p className="muted" style={{ marginTop: 12 }}>{s.budgetReqSent}</p>}
            </div>

            {/* meta connection */}
            <div className="card">
              <div className="row between" style={{ marginBottom: 14 }}>
                <b style={{ fontSize: "1.1rem" }}>{s.metaTitle}</b>
                <StatusPill variant={health.healthy ? "ok" : "attn"}>
                  {health.healthy ? a.connect.connected : a.connect.missing}
                </StatusPill>
              </div>
              <div className="summary-row"><span className="k">{a.connect.adAccount}</span><b>{adAccountLabel(conn?.adAccount) || L.none}</b></div>
              <div className="summary-row"><span className="k">{a.connect.fbPage}</span><b>{conn?.pageId || L.none}</b></div>
              <div className="summary-row"><span className="k">{a.connect.instagram}</span><b>{conn?.instagramId || L.none}</b></div>
              {conn?.adAccount && (
                <p className="mono muted" style={{ fontSize: "0.72rem", margin: "12px 0" }}>
                  {a.connect.technical}: {conn.adAccount.metaAdAccountId}
                  {conn.pageId ? ` · ${conn.pageId}` : ""}{conn.instagramId ? ` · ${conn.instagramId}` : ""}
                </p>
              )}
              <button className="btn btn-outline btn-sm" onClick={checkConnection} disabled={connChecking}>
                {connChecking ? s.checking : s.checkConn}
              </button>
            </div>

            {/* plan / billing */}
            {sub ? (
              <div className="card">
                <div className="row between" style={{ marginBottom: 14 }}>
                  <b style={{ fontSize: "1.1rem" }}>{s.planTitle}</b>
                  <b>{shekels(sub.monthlyAmountAgorot)} <span className="muted" style={{ fontWeight: 400 }}>{a.checkout.perMonth}</span></b>
                </div>
                <div className="summary-row"><span className="k">{s.planLine}</span><StatusPill variant={sub.setupPaid ? "ok" : "neutral"}>{sub.setupPaid ? s.setupPaid : s.setupPending}</StatusPill></div>
                <div className="summary-row"><span className="k">{s.nextCharge}</span><b>{sub.nextChargeDate ? new Date(sub.nextChargeDate).toLocaleDateString("he-IL") : L.none}</b></div>
                <div className="summary-row"><span className="k">{s.payMethod}</span><b>{s.payMethodManual}</b></div>
              </div>
            ) : (
              <div className="card">
                <b style={{ fontSize: "1.1rem", display: "block", marginBottom: 8 }}>{s.noSubTitle}</b>
                <p className="muted">{s.noSubNote}</p>
              </div>
            )}

            {/* account */}
            <div className="card">
              <b style={{ fontSize: "1.1rem", display: "block", marginBottom: 16 }}>{s.accountTitle}</b>
              <div className="stack gap16">
                <Field label={s.nameLabel} value={ov.account.name || ov.customer?.contactName || L.none} />
                <Field label={s.emailLabel} value={ov.account.email} type="email" />
                <ChangePassword />
              </div>
              <hr />
              <p className="muted" style={{ fontSize: "0.9rem" }}>
                {s.cancelNote} <a className="link" href={WA}>{s.cancelLink}</a>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) return <p className="muted" style={{ margin: 0 }}>✓ {s.pwDone}</p>;
  if (!open) return <div><button className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>{s.changePw}</button></div>;

  function save() {
    if (next.length < 8) { setError(s.pwTooShort); return; }
    setSaving(true); setError(null);
    changePassword(current, next)
      .then(() => setDone(true))
      .catch((e) => setError(e instanceof ApiError && e.status === 401 ? s.pwWrong : s.pwTooShort))
      .finally(() => setSaving(false));
  }

  return (
    <div className="stack gap12">
      <div className="field"><label>{s.pwCurrent}</label>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field"><label>{s.pwNew}</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      {error && <p className="muted" style={{ margin: 0 }}>{error}</p>}
      <div className="row gap12">
        <button className="btn btn-dark btn-sm" onClick={save} disabled={saving}>{s.pwSave}</button>
        <button className="btn btn-outline btn-sm" onClick={() => setOpen(false)}>{s.pwCancel}</button>
      </div>
    </div>
  );
}
