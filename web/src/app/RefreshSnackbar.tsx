import { useEffect, useRef, useState } from "react";
import { strings } from "../strings";
import { useSharedOverview } from "./overview-store";
import { LINGER_MS, snackFor, type SnackKind } from "./refresh-snackbar";

const t = strings.he.app.snack;

const SUB: Partial<Record<SnackKind, string>> = {
  refreshing: t.refreshingSub,
  throttled: t.throttledSub,
  stalled: t.stalledSub,
};

// AIC-193 — tells the customer the numbers are on their way.
//
// With polling off, a campaign's first load renders what is stored while Meta
// is read in the background, and without this the page is a row of dashes that
// looks broken. The decision lives in refresh-snackbar.ts; this is timers and
// markup.
export function RefreshSnackbar() {
  const { data, loading, stalled } = useSharedOverview();
  const [shown, setShown] = useState<SnackKind | null>(null);
  const [leaving, setLeaving] = useState(false);
  const prev = useRef<SnackKind | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const next = snackFor(prev.current, {
    loading, hasData: !!data, dataRefresh: data?.dataRefresh, stalled,
  });

  useEffect(() => {
    if (next === prev.current) return;
    prev.current = next;
    clearTimeout(timer.current);

    if (next) {
      setLeaving(false);
      setShown(next);
      const linger = LINGER_MS[next];
      // Outcomes (updated / rate-limited / stalled) linger and leave on their own.
      if (linger != null) timer.current = setTimeout(() => setLeaving(true), linger);
    } else if (shown && LINGER_MS[shown] == null) {
      // An in-progress snackbar whose condition ended without an outcome to
      // announce — e.g. a campaign switch that landed on already-fresh data.
      setLeaving(true);
    }
  }, [next]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!shown) return null;
  const busy = shown === "refreshing" || shown === "loading_campaign";
  const tone = shown === "refreshed" ? "ok" : shown === "throttled" || shown === "stalled" ? "warn" : "busy";

  return (
    <div
      className={`snack snack-${tone}${leaving ? " snack-leave" : ""}`}
      role="status"
      aria-live="polite"
      onAnimationEnd={() => { if (leaving) { setShown(null); setLeaving(false); } }}
    >
      <span className="snack-icon" aria-hidden="true">
        {busy ? <span className="snack-spinner" /> : tone === "ok" ? "✓" : "!"}
      </span>
      <span className="snack-text">
        <b>{t[shown]}</b>
        {SUB[shown] && <span className="snack-sub">{SUB[shown]}</span>}
      </span>
      {!busy && (
        <button type="button" className="snack-x" aria-label={t.dismiss} onClick={() => setLeaving(true)}>×</button>
      )}
      {shown === "refreshing" && <span className="snack-bar" aria-hidden="true" />}
    </div>
  );
}
