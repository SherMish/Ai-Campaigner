import { strings } from "../strings";
import { getImpersonationToken, clearImpersonationToken } from "../api";
import { readImpersonation } from "./impersonation";

const t = strings.he.app.impersonation;

// AIC-189 — an unmissable marker that the account on screen belongs to somebody
// else, and is real.
//
// Not dismissable, and not a toast. The failure it prevents is quiet: an admin
// skims a customer's numbers, forgets whose they are, and reasons about the
// product from one business's data — or worse, believes a real customer's spend
// is test data. A banner that can be closed is a banner that is closed.
export function ImpersonationBar({ name }: { name?: string | null }) {
  const imp = readImpersonation(getImpersonationToken());
  if (!imp) return null;

  function exit() {
    // Drop the viewing token — only that. The admin's own session is in a
    // different slot and was never touched, so the console is still signed in.
    // A full reload rather than a route change: every store in memory holds the
    // customer's data, and carrying that into the admin screens is how the
    // wrong numbers end up in front of the wrong person.
    clearImpersonationToken();
    window.location.assign("/admin/users");
  }

  return (
    <div className="imp-bar" role="alert">
      <span className="imp-badge">{t.badge}</span>
      <span className="imp-text">
        <strong>{t.title}</strong>
        {" · "}{t.body} <strong>{name?.trim() || imp.userId}</strong>
        {" · "}{t.readOnly}
      </span>
      <button className="imp-exit" onClick={exit}>{t.exit}</button>
    </div>
  );
}
