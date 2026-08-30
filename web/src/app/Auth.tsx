import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { AuthLayout, Field, WA } from "./components";
import { api, ApiError, setAuthToken } from "../api";
import { resetAnalytics } from "../analytics";

const a = strings.he.app;

function ErrorNote({ msg }: { msg: string }) {
  if (!msg) return null;
  return <p style={{ color: "var(--orange)", fontSize: "0.9rem", margin: "4px 0 0" }}>{msg}</p>;
}

export function Signup() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const { token } = await api<{ token: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      });
      // A fresh session must not inherit the previous customer's identity —
      // the server re-identifies from /overview once it knows who this is.
      resetAnalytics();
      setAuthToken(token);
      nav("/onboarding");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "ההרשמה נכשלה, נסו שוב.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>{a.auth.signupTitle}</h1>
      <p className="muted" style={{ margin: "10px 0 26px" }}>{a.auth.signupSub}</p>
      <form className="stack gap16" onSubmit={submit}>
        <Field label={a.auth.name} value={name} onChange={setName} />
        <Field label={a.auth.email} type="email" value={email} onChange={setEmail} />
        <Field label={a.auth.password} type="password" value={password} onChange={setPassword} />
        <label className="check">
          <input type="checkbox" defaultChecked />
          <span>
            {a.auth.terms.pre}
            <a className="link" href="/terms.html" target="_blank" rel="noopener noreferrer">{a.auth.terms.tos}</a>
            {a.auth.terms.mid}
            <a className="link" href="/privacy.html" target="_blank" rel="noopener noreferrer">{a.auth.terms.privacy}</a>
            {a.auth.terms.post}
          </span>
        </label>
        <ErrorNote msg={err} />
        <button className="btn btn-primary block" type="submit" disabled={busy}>{a.auth.createAccount}</button>
      </form>
      <p className="muted center" style={{ marginTop: 20 }}>
        {a.auth.haveAccount} <Link className="link" to="/login">{a.auth.login}</Link>
      </p>
      <p className="center" style={{ marginTop: 24 }}>
        <span className="muted">{a.auth.preQuestion} </span>
        <a className="link" href={WA}>{a.talkWa}</a>
      </p>
    </AuthLayout>
  );
}

export function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const { token } = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      // A fresh session must not inherit the previous customer's identity —
      // the server re-identifies from /overview once it knows who this is.
      resetAnalytics();
      setAuthToken(token);
      nav("/app");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? "אימייל או סיסמה שגויים." : "הכניסה נכשלה, נסו שוב.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>{a.auth.loginTitle}</h1>
      <p className="muted" style={{ margin: "10px 0 26px" }}>{a.auth.loginSub}</p>
      <form className="stack gap16" onSubmit={submit}>
        <Field label={a.auth.email} type="email" value={email} onChange={setEmail} />
        <Field label={a.auth.password} type="password" value={password} onChange={setPassword} />
        <div className="row between">
          <Link className="link" to="/forgot" style={{ fontSize: "0.9rem" }}>{a.auth.forgotLink}</Link>
        </div>
        <ErrorNote msg={err} />
        <button className="btn btn-primary block" type="submit" disabled={busy}>{a.auth.login}</button>
      </form>
      <p className="muted center" style={{ marginTop: 20 }}>
        {a.auth.noAccount} <Link className="link" to="/signup">{a.auth.signup}</Link>
      </p>
    </AuthLayout>
  );
}

export function Forgot() {
  const [sent, setSent] = useState(false);
  return (
    <AuthLayout>
      {!sent ? (
        <>
          <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>{a.auth.forgotTitle}</h1>
          <p className="muted" style={{ margin: "10px 0 26px" }}>{a.auth.forgotSub}</p>
          <form className="stack gap16" onSubmit={(e) => { e.preventDefault(); setSent(true); }}>
            <Field label={a.auth.email} type="email" placeholder={a.mock.email} />
            <button className="btn btn-primary block" type="submit">{a.auth.sendLink}</button>
          </form>
          <p className="center" style={{ marginTop: 20 }}>
            <Link className="link" to="/login">{a.auth.backToLogin}</Link>
          </p>
        </>
      ) : (
        <div className="center">
          <div className="pill ok" style={{ margin: "8px auto 18px" }}><span className="dot" />✓</div>
          <h1 style={{ fontSize: "1.7rem", fontWeight: 800 }}>{a.auth.forgotSentTitle}</h1>
          <p className="muted" style={{ margin: "10px 0" }}>{a.mock.email}</p>
          <p className="muted">{a.auth.forgotSent}</p>
          <div className="row gap12" style={{ justifyContent: "center", marginTop: 24 }}>
            <Link className="btn btn-dark" to="/login">{a.settings.title && a.auth.backToLogin.replace("← ", "")}</Link>
            <button className="btn btn-outline" onClick={() => setSent(false)}>{a.auth.resend}</button>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}

export function Reset() {
  const [done, setDone] = useState(false);
  const nav = useNavigate();
  return (
    <AuthLayout>
      {!done ? (
        <>
          <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>{a.auth.resetTitle}</h1>
          <p className="muted" style={{ margin: "10px 0 26px" }}>{a.auth.resetSub}</p>
          <form className="stack gap16" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <Field label={a.auth.password} type="password" />
            <button className="btn btn-primary block" type="submit">{a.auth.savePassword}</button>
          </form>
        </>
      ) : (
        <div className="center">
          <div className="pill ok" style={{ margin: "8px auto 18px" }}><span className="dot" />✓</div>
          <h1 style={{ fontSize: "1.7rem", fontWeight: 800 }}>{a.auth.resetDoneTitle}</h1>
          <p className="muted" style={{ margin: "10px 0 24px" }}>{a.auth.resetDoneSub}</p>
          <button className="btn btn-primary" onClick={() => nav("/login")}>{a.auth.loginToAccount}</button>
        </div>
      )}
    </AuthLayout>
  );
}
