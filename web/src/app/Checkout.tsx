import { useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { Brand, Field, WA } from "./components";

const a = strings.he.app;

export function Checkout() {
  const nav = useNavigate();
  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <Brand />
          <a className="link" href={WA}>{a.checkout.payQuestion} {a.talk}</a>
        </div>
      </header>
      <div className="wrap page">
        <div className="center" style={{ marginBottom: 36 }}>
          <h1>{a.checkout.title}</h1>
          <p className="muted" style={{ marginTop: 10 }}>{a.checkout.sub}</p>
        </div>
        <div className="grid-2" style={{ maxWidth: 900, margin: "0 auto" }}>
          <div className="card">
            <h3 style={{ fontSize: "1.2rem", marginBottom: 16 }}>{a.checkout.payDetails} <span className="mono muted" style={{ fontSize: "0.7rem" }}>🔒 SECURE</span></h3>
            <div className="stack gap16">
              <Field label="שם על הכרטיס" />
              <Field label="מספר כרטיס" placeholder="•••• •••• •••• 4417" />
              <div className="row gap12">
                <Field label="תוקף" placeholder="MM/YY" />
                <Field label="CVC" placeholder="•••" />
              </div>
            </div>
            <hr />
            <div className="row between" style={{ marginBottom: 6 }}>
              <span className="muted">{a.checkout.payNow}</span>
              <b style={{ fontSize: "1.4rem" }}>₪598</b>
            </div>
            <p className="muted mono" style={{ fontSize: "0.78rem" }}>{a.checkout.firstCharge}</p>
            <button className="btn btn-primary block" style={{ marginTop: 16 }} onClick={() => nav("/onboarding")}>
              {a.checkout.proceed}
            </button>
            <p className="muted center" style={{ fontSize: "0.8rem", marginTop: 12 }}>{a.checkout.cancelNote}</p>
          </div>

          <div className="card card-dark">
            <div className="mono" style={{ fontSize: "0.72rem", opacity: 0.6 }}>{a.checkout.plan}</div>
            <div style={{ fontSize: "3rem", fontWeight: 900, margin: "6px 0" }}>
              ₪299 <span style={{ fontSize: "1rem", fontWeight: 600, opacity: 0.7 }}>{a.checkout.perMonth}</span>
            </div>
            <div className="mono" style={{ fontSize: "0.8rem", opacity: 0.6 }}>₪299 {a.checkout.setupOnce}</div>
            <ul style={{ listStyle: "none", padding: 0, margin: "22px 0 0", display: "grid", gap: 10 }}>
              {a.checkout.includes.map((f, i) => (
                <li key={i} style={{ display: "flex", gap: 10 }}>
                  <span style={{ color: "var(--green)", fontWeight: 800 }}>✓</span> {f}
                </li>
              ))}
            </ul>
            <p style={{ opacity: 0.6, fontSize: "0.85rem", marginTop: 22 }}>{a.checkout.metaNote}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
