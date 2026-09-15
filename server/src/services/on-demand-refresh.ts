// AIC-191 — refresh ONE campaign's data from Meta when its dashboard is opened.
//
// Replaces hourly polling, which put every campaign on an ad account into one
// burst each hour and got that account rate-limited (code 17) every hour for
// five days. Refreshing on demand only helps if a demand is not itself a burst,
// so the rules below are the whole point of this module:
//
//   freshness   — refreshed within FRESH_FOR → no Meta calls at all
//   one-at-once — concurrent requests for a campaign share one refresh
//   back-off    — a rate limit on an ad account silences that ACCOUNT for a
//                 while, instead of firing the remaining calls into a block
//                 that each one extends
//   bounded     — the request waits a little, then serves what it has
//
// The rules take injected dependencies so they are tested without Meta.

export const FRESH_FOR_MS = 10 * 60_000;
export const THROTTLE_BACKOFF_MS = 15 * 60_000;
// Zero: never hold the page for Meta. A full refresh measured 15–20 s live, so
// no reasonable wait ever caught one — an 8 s wait gave a 12 s first load, and
// 2.5 s still gave 8 s, because the page then built its overview alongside the
// refresh. The dashboard renders stored data and reloads when the refresh lands
// (overview-store.ts). A fresh campaign never reaches this wait at all.
export const WAIT_FOR_REFRESH_MS = 0;

export type RefreshState =
  | "fresh"        // recent enough; nothing called
  | "refreshed"    // refreshed during this request
  | "refreshing"   // started, still running after the wait; finishes in background
  | "throttled"    // the ad account is backing off; cached data served
  | "unavailable"; // no campaign, not linked to Meta, or no usable credential

export interface CampaignToRefresh {
  campaignId: string;
  metaCampaignId: string | null;
  adAccountId: string | null;
  refreshedAt: Date | null;
}

export interface RefresherDeps {
  load(campaignId: string): Promise<CampaignToRefresh | null>;
  /** Pulls everything from Meta. Throws on failure; a rate limit is detected by isThrottle. */
  refresh(c: CampaignToRefresh): Promise<void>;
  markRefreshed(campaignId: string, at: Date): Promise<void>;
  isThrottle(e: unknown): boolean;
  now?: () => Date;
  log?: (msg: string, e?: unknown) => void;
  freshForMs?: number;
  backoffMs?: number;
  waitMs?: number;
}

export function createRefresher(deps: RefresherDeps) {
  const now = deps.now ?? (() => new Date());
  const freshFor = deps.freshForMs ?? FRESH_FOR_MS;
  const backoff = deps.backoffMs ?? THROTTLE_BACKOFF_MS;
  const wait = deps.waitMs ?? WAIT_FOR_REFRESH_MS;

  // Per-process. One Railway instance today; with several, each would back off
  // on its own schedule, which is still far below the hourly burst it replaces.
  const inflight = new Map<string, Promise<RefreshState>>();
  const throttledUntil = new Map<string, number>();

  async function run(c: CampaignToRefresh): Promise<RefreshState> {
    try {
      await deps.refresh(c);
      await deps.markRefreshed(c.campaignId, now());
      return "refreshed";
    } catch (e) {
      if (deps.isThrottle(e)) {
        if (c.adAccountId) throttledUntil.set(c.adAccountId, now().getTime() + backoff);
        deps.log?.(`[refresh] ${c.campaignId}: ad account ${c.adAccountId} rate-limited, backing off`);
        return "throttled";
      }
      deps.log?.(`[refresh] ${c.campaignId} failed`, e);
      return "unavailable";
    }
  }

  return async function ensureFresh(campaignId: string): Promise<RefreshState> {
    const c = await deps.load(campaignId);
    if (!c || !c.metaCampaignId) return "unavailable";

    const t = now().getTime();
    if (c.refreshedAt && t - c.refreshedAt.getTime() < freshFor) return "fresh";

    if (c.adAccountId) {
      const until = throttledUntil.get(c.adAccountId);
      if (until && until > t) return "throttled";
    }

    let p = inflight.get(campaignId);
    if (!p) {
      p = run(c).finally(() => inflight.delete(campaignId));
      inflight.set(campaignId, p);
    }

    // Bounded: the page must not hang on Meta. A refresh still running after
    // the wait keeps going and marks the campaign fresh for the next load.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RefreshState>((resolve) => {
      timer = setTimeout(() => resolve("refreshing"), wait);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// Meta signals a rate limit in two shapes here: GraphWriteError from the
// campaign adapter, and a plain Error carrying Meta's JSON from the insights
// client. Codes per Meta's docs: 4 (app), 17 (user/ad account), 32 (page),
// 613 (per-endpoint), 80004 (ads management tier).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);

export function isRateLimit(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number" && RATE_LIMIT_CODES.has(code)) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = msg.match(/"code"\s*:\s*(\d+)/);
  if (m && RATE_LIMIT_CODES.has(Number(m[1]))) return true;
  return /User request limit reached|too many calls/i.test(msg);
}
