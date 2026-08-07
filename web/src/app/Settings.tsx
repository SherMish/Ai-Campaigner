import { strings } from "../strings";
import { AppHeader, StatusPill, SupportCard, Field, WA } from "./components";

const a = strings.he.app;
const s = a.settings;

export function Settings() {
  return (
    <div>
      <AppHeader recCount={1} />
      <div className="wrap page" style={{ maxWidth: 820, marginInline: "auto" }}>
        <h1 style={{ marginBottom: 24 }}>{s.title}</h1>

        <div className="stack gap20" style={{ gap: 20 }}>
          <SupportCard />

          {/* budget */}
          <div className="card">
            <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <b style={{ fontSize: "1.1rem" }}>{s.budgetTitle}</b>
                <p className="muted" style={{ marginTop: 6 }}>{s.budgetNote}</p>
              </div>
              <div className="row gap16">
                <b style={{ fontSize: "1.4rem" }}>₪80 <span className="muted" style={{ fontSize: "0.9rem", fontWeight: 400 }}>ביום</span></b>
                <button className="btn btn-outline btn-sm">{s.budgetReq}</button>
              </div>
            </div>
          </div>

          {/* meta connection */}
          <div className="card">
            <div className="row between" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: "1.1rem" }}>{s.metaTitle}</b>
              <StatusPill variant="ok">{a.connect.connected}</StatusPill>
            </div>
            <div className="summary-row"><span className="k">{a.connect.adAccount}</span><b>סטודיו לילך — פרסום</b></div>
            <div className="summary-row"><span className="k">{a.connect.fbPage}</span><b>סטודיו לילך</b></div>
            <div className="summary-row"><span className="k">{a.connect.instagram}</span><b>@studio.lilach</b></div>
            <p className="mono muted" style={{ fontSize: "0.72rem", margin: "12px 0" }}>{a.connect.technical}: act_882401553 · page_1049823117 · ig_17841400082</p>
            <button className="btn btn-outline btn-sm">{s.checkConn}</button>
          </div>

          {/* plan / billing */}
          <div className="card">
            <div className="row between" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: "1.1rem" }}>{s.planTitle}</b>
              <b>₪299 <span className="muted" style={{ fontWeight: 400 }}>{a.checkout.perMonth}</span></b>
            </div>
            <div className="summary-row"><span className="k">{s.planLine}</span><StatusPill variant="ok">{s.setupPaid}</StatusPill></div>
            <div className="summary-row"><span className="k">{s.nextCharge}</span><b>{s.nextChargeVal}</b></div>
            <div className="summary-row"><span className="k">{s.payMethod}</span><b>{s.payMethodVal}</b></div>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 14 }}>{s.managePay}</button>
          </div>

          {/* account */}
          <div className="card">
            <b style={{ fontSize: "1.1rem", display: "block", marginBottom: 16 }}>{s.accountTitle}</b>
            <div className="stack gap16">
              <Field label={s.nameLabel} value={a.mock.userName} />
              <Field label={s.emailLabel} value={a.mock.email} type="email" />
              <div><button className="btn btn-outline btn-sm">{s.changePw}</button></div>
            </div>
            <hr />
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              {s.cancelNote} <a className="link" href={WA}>{s.cancelLink}</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
