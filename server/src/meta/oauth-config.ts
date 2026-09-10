// AIC-186 — the Business Login dialog URL, and the environment it needs.
//
// Kept apart from the routes so the URL we send a customer to is a pure
// function of configuration, testable without an HTTP server. Getting this URL
// wrong is not a 500 — it is a customer landing on a Meta error page mid-signup
// with no idea what happened.

// Pinned, and pinned to the SAME version the adapter calls. A dialog that
// grants against one version while the backend writes against another is how
// scope drift becomes a runtime permission error weeks later.
export const GRAPH_VERSION = "v21.0";

const DIALOG_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
export const TOKEN_EXCHANGE_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;

// The seven granular scopes the working production token already carries. This
// list is not what we ASK for — the Business Login configuration owns that —
// it is what we VERIFY we were given, in oauth-exchange.
export const REQUIRED_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_ads",
] as const;

// Granted only when the customer has an Instagram business account, which many
// do not. Wanted, never required — see docs/features/meta-connection.md.
export const OPTIONAL_SCOPES = ["instagram_basic"] as const;

export interface OauthConfig {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
}

export class OauthNotConfiguredError extends Error {}

// Every value or none. A partially configured flow fails at the callback —
// after the customer has already consented — which is the worst possible place
// to discover it, so the check happens before we build the first URL.
export function readOauthConfig(env: NodeJS.ProcessEnv = process.env): OauthConfig {
  const appId = env.META_APP_ID?.trim();
  const appSecret = env.META_APP_SECRET?.trim();
  const configId = env.META_LOGIN_CONFIG_ID?.trim();
  const redirectUri = env.META_OAUTH_REDIRECT_URI?.trim();

  const missing = [
    ["META_APP_ID", appId],
    ["META_APP_SECRET", appSecret],
    ["META_LOGIN_CONFIG_ID", configId],
    ["META_OAUTH_REDIRECT_URI", redirectUri],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new OauthNotConfiguredError(`Meta OAuth is not configured: missing ${missing.join(", ")}`);
  }

  // Meta compares the redirect_uri between the dialog call and the token
  // exchange as an exact string. A trailing slash difference is a rejected
  // exchange with an error that names neither side, so it is refused here
  // where the message can say what to fix.
  if (!redirectUri!.startsWith("https://") && !redirectUri!.startsWith("http://localhost")) {
    throw new OauthNotConfiguredError(
      `META_OAUTH_REDIRECT_URI must be https (or http://localhost for dev), got ${redirectUri}`,
    );
  }

  return { appId: appId!, appSecret: appSecret!, configId: configId!, redirectUri: redirectUri! };
}

export function oauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_OAUTH_ENABLED === "true";
}

// The URL the customer is sent to.
//
// No `scope` parameter: with a Business Login configuration the permissions and
// assets live in the configuration, and passing scope alongside config_id makes
// the two sources of truth able to disagree.
export function buildDialogUrl(config: OauthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    config_id: config.configId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state,
  });
  return `${DIALOG_BASE}?${params.toString()}`;
}

export type OauthOutcome = "connected" | "refused" | "failed";

// Where the customer lands after the callback.
//
// A query flag rather than a flash message because the SPA is reached by a
// fresh page load — there is no in-memory state to carry across the redirect.
//
// AIC-187 (found in browser testing): this pointed at `/app/onboarding`, which
// is NOT a route — the SPA registers `/onboarding` (App.tsx). A customer who
// completed consent therefore landed inside the app shell with no confirmation
// that anything had happened, which is the exact failure the outcome parameter
// exists to prevent.
//
// Success goes to the DASHBOARD, not back to onboarding. Adoption has already
// run by the time we redirect — the customer's campaigns are in the database —
// so returning them to a status page that says "we are reviewing your campaign,
// there is nothing to do" is a wall in front of data they can already see. The
// dashboard showing their own campaigns is the confirmation.
//
// The two failure outcomes still return to onboarding, because that is where
// the connect button is and trying again is the whole point.
export function oauthReturnUrl(
  outcome: OauthOutcome,
  detail?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.APP_BASE_URL?.replace(/\/$/, "") ?? "";
  if (outcome === "connected") return `${base}/app`;
  const params = new URLSearchParams({ meta: outcome });
  if (detail) params.set("reason", detail);
  return `${base}/onboarding?${params.toString()}`;
}
