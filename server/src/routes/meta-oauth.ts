import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { rateLimit } from "../middleware/security.js";
import { mintState, parseState, StateError } from "../meta/oauth-state.js";
import { rememberState, spendState, saveOauthConnection, NonceError, type AdoptedCampaign } from "../meta/oauth-store.js";
import { readOauthConfig, buildDialogUrl, oauthEnabled, OauthNotConfiguredError } from "../meta/oauth-config.js";
import { completeOauth, OauthRefusedError, OauthFaultError, type FetchLike } from "../meta/oauth-exchange.js";
import { tokenCryptoReady } from "../meta/token-crypto.js";
import { GRAPH_VERSION } from "../meta/oauth-config.js";

// AIC-186 — customer-facing Meta connection.
//
// Two endpoints with deliberately different auth models:
//
//   POST /start    authed (JWT). The SPA has the session; it asks for a URL.
//   GET  /callback UNAUTHED, by necessity. Meta redirects the customer's
//                  browser here and a top-level navigation carries no
//                  Authorization header. Identity comes from the signed,
//                  single-use `state` instead — see meta/oauth-state.ts.
export const metaOauthRouter = Router();

// The callback is unauthenticated and does real work (network calls to Meta,
// a write transaction). Rate limited on that basis alone.
const startLimit = rateLimit({ name: "oauth-start", limit: 10, windowMs: 15 * 60_000 });
const callbackLimit = rateLimit({ name: "oauth-callback", limit: 20, windowMs: 15 * 60_000 });

// Where the customer lands afterwards. A query flag rather than a flash message
// because the SPA is reached by a fresh page load: there is no in-memory state
// to carry anything across the redirect.
function appRedirect(outcome: "connected" | "refused" | "failed", detail?: string): string {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, "") ?? "";
  const params = new URLSearchParams({ meta: outcome });
  if (detail) params.set("reason", detail);
  return `${base}/app/onboarding?${params.toString()}`;
}

metaOauthRouter.post("/start", startLimit, requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  if (!oauthEnabled()) {
    res.status(404).json({ error: "not enabled" });
    return;
  }
  try {
    const config = readOauthConfig();
    // Checked HERE, not at the callback. Discovering we cannot store a token
    // after the customer has already granted access means throwing away a real
    // consent and asking them to do it again.
    if (!tokenCryptoReady()) {
      throw new OauthNotConfiguredError("META_TOKEN_ENC_KEY is not set");
    }
    const { state, nonce, expiresAt } = mintState(userId);
    await rememberState(pool, nonce, userId, expiresAt);
    res.json({ url: buildDialogUrl(config, state) });
  } catch (e) {
    if (e instanceof OauthNotConfiguredError) {
      console.error("[meta-oauth] start refused:", e.message);
      res.status(503).json({ error: "meta connection is not available right now" });
      return;
    }
    console.error("[meta-oauth] start failed", e);
    res.status(500).json({ error: "could not start the Meta connection" });
  }
});

metaOauthRouter.get("/callback", callbackLimit, async (req, res) => {
  if (!oauthEnabled()) {
    res.status(404).send("not enabled");
    return;
  }

  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  // The customer pressed Cancel, or Meta refused. Not an error on our side and
  // not something to log as one — but they must land somewhere that says so.
  if (error) {
    console.warn("[meta-oauth] customer did not complete consent:", error, error_description ?? "");
    res.redirect(appRedirect("refused", error));
    return;
  }
  if (typeof code !== "string" || typeof state !== "string") {
    res.redirect(appRedirect("failed", "missing_code"));
    return;
  }

  try {
    const { nonce, userId } = parseState(state);
    // Spend before doing anything expensive: a replayed callback should cost
    // us one UPDATE, not a full round of Meta calls.
    await spendState(pool, nonce, userId);

    const config = readOauthConfig();
    const result = await completeOauth(config, code, fetch as unknown as FetchLike);

    const adAccountId = result.assets.adAccountIds[0];
    const pageId = result.assets.pageIds[0];
    const account = await readAccount(adAccountId, result.accessToken);
    const campaigns = await readCampaigns(adAccountId, result.accessToken);

    const { adopted } = await saveOauthConnection(pool, {
      userId,
      result,
      adAccountId,
      pageId,
      instagramId: result.assets.instagramIds[0] ?? null,
      accountName: account.name,
      currency: account.currency,
      timezone: account.timezone,
      campaigns,
    });

    console.log(`[meta-oauth] connected user=${userId} account=${adAccountId} campaigns=${adopted}`);
    res.redirect(appRedirect("connected"));
  } catch (e) {
    if (e instanceof StateError || e instanceof NonceError) {
      // Includes the replay case. One message, no detail — see spendState.
      console.warn("[meta-oauth] state rejected:", (e as Error).message);
      res.redirect(appRedirect("failed", "link_expired"));
      return;
    }
    if (e instanceof OauthRefusedError) {
      console.warn("[meta-oauth] incomplete grant:", e.message);
      res.redirect(appRedirect("refused", e.message));
      return;
    }
    console.error("[meta-oauth] callback failed", e);
    res.redirect(appRedirect("failed", e instanceof OauthFaultError ? "meta_error" : "server_error"));
  }
});

// Read the ad account's own metadata. ad_accounts requires name/currency/
// timezone NOT NULL, and guessing them produces a dashboard that quietly
// reports the wrong currency.
async function readAccount(adAccountId: string, token: string) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}?fields=name,currency,timezone_name`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as { name?: string; currency?: string; timezone_name?: string; error?: unknown };
  if (body.error) throw new OauthFaultError(`reading the ad account: ${JSON.stringify(body.error)}`);
  return {
    name: body.name ?? adAccountId,
    currency: body.currency ?? "ILS",
    timezone: body.timezone_name ?? "Asia/Jerusalem",
  };
}

// Every campaign on the account — the customer asked to see all of them.
async function readCampaigns(adAccountId: string, token: string): Promise<AdoptedCampaign[]> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/campaigns` +
      `?fields=id,name,objective,daily_budget&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as { data?: unknown[]; error?: unknown };
  if (body.error) throw new OauthFaultError(`reading campaigns: ${JSON.stringify(body.error)}`);
  if (!Array.isArray(body.data)) return [];
  return body.data.flatMap((row) => {
    const c = row as { id?: unknown; name?: unknown; objective?: unknown; daily_budget?: unknown };
    if (typeof c.id !== "string") return [];
    return [{
      metaCampaignId: c.id,
      name: typeof c.name === "string" ? c.name : c.id,
      // Our own vocabulary, not Meta's. Anything we do not recognise is
      // adopted as 'leads' rather than dropped: an unfamiliar objective is
      // still the customer's campaign and still belongs in their switcher.
      objective: c.objective === "OUTCOME_ENGAGEMENT" ? "engagement" : "leads",
      dailyBudgetAgorot: typeof c.daily_budget === "string" ? Number(c.daily_budget) || null : null,
    }];
  });
}
