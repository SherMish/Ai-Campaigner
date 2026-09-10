import {
  GRAPH_VERSION,
  TOKEN_EXCHANGE_URL,
  REQUIRED_SCOPES,
  type OauthConfig,
} from "./oauth-config.js";

// AIC-186 — code → token → "what did they actually grant us".
//
// `fetch` is injected so every branch here is unit-testable without network,
// matching GraphMetaClient's shape (meta/client.ts).

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GrantedAssets {
  metaUserId: string | null;
  businessIds: string[];
  adAccountIds: string[];
  pageIds: string[];
  instagramIds: string[];
}

export interface ExchangeResult {
  accessToken: string;
  scopes: string[];
  assets: GrantedAssets;
}

// Two failure kinds, because they need different answers in the UI. A refusal
// is the customer's to fix (they declined an asset, the grant is incomplete);
// a fault is ours or Meta's and the customer can only retry.
export class OauthRefusedError extends Error {}
export class OauthFaultError extends Error {}

async function readJson(res: { ok: boolean; status: number; json: () => Promise<unknown> }, what: string) {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OauthFaultError(`${what}: Meta returned a non-JSON body (HTTP ${res.status})`);
  }
  const err = (body as { error?: { message?: string; type?: string; code?: number } })?.error;
  if (err) {
    // Meta's own words, not ours. Same rule as graph-refusal.ts: if Meta wrote
    // a message a person could act on, printing our paraphrase instead throws
    // away the only useful part of the response.
    throw new OauthFaultError(`${what}: ${err.message ?? "unknown Meta error"} (code ${err.code ?? "?"})`);
  }
  if (!res.ok) throw new OauthFaultError(`${what}: HTTP ${res.status}`);
  return body;
}

// Step 1 — the authorization code becomes a token. Server-side only: this is
// the single call that uses the app secret.
export async function exchangeCode(
  config: OauthConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    // Meta compares this against the dialog's redirect_uri as an exact string.
    redirect_uri: config.redirectUri,
    code,
  });
  const body = await readJson(
    await fetchImpl(`${TOKEN_EXCHANGE_URL}?${params.toString()}`),
    "token exchange",
  );
  const token = (body as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !token) {
    throw new OauthFaultError("token exchange: Meta returned no access_token");
  }
  return token;
}

// Step 2 — what IS this token, and does it carry what we need?
//
// A 200 from the exchange is not proof the grant is usable: the customer can
// complete the dialog having declined an asset type, and the token comes back
// perfectly valid and missing the scope we need. Checking here means the
// failure is reported at connect time, with a list of what is missing, rather
// than as a permission error during a 3am ingestion tick.
export async function inspectToken(
  config: OauthConfig,
  token: string,
  fetchImpl: FetchLike,
): Promise<{ metaUserId: string | null; scopes: string[] }> {
  const params = new URLSearchParams({
    input_token: token,
    access_token: `${config.appId}|${config.appSecret}`,
  });
  const body = await readJson(
    await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?${params.toString()}`),
    "token inspection",
  );
  const data = (body as { data?: Record<string, unknown> }).data ?? {};
  if (data.is_valid === false) throw new OauthFaultError("token inspection: Meta reports the token is not valid");

  // granular_scopes is the accurate list when assets were picked individually;
  // `scopes` is the superset. Prefer granular, fall back.
  const granular = Array.isArray(data.granular_scopes)
    ? (data.granular_scopes as Array<{ scope?: unknown }>)
        .map((g) => g?.scope)
        .filter((s): s is string => typeof s === "string")
    : [];
  const flat = Array.isArray(data.scopes)
    ? (data.scopes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const scopes = granular.length ? granular : flat;

  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) {
    throw new OauthRefusedError(`missing permissions: ${missing.join(", ")}`);
  }

  const uid = data.user_id;
  return { metaUserId: typeof uid === "string" ? uid : null, scopes };
}

// Step 3 — enumerate what the token can actually reach.
//
// The customer chose assets in Meta's picker and we were not told which. Asking
// is the only way to know, and it must be asked per edge: a token can carry
// `business_management` and reach zero businesses.
async function listIds(
  path: string,
  token: string,
  fetchImpl: FetchLike,
  what: string,
): Promise<string[]> {
  const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readJson(res, what);
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => (row as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function discoverAssets(token: string, fetchImpl: FetchLike): Promise<Omit<GrantedAssets, "metaUserId">> {
  // Sequential, not Promise.all. Four parallel calls against a freshly minted
  // token is exactly the burst that earns a code-17 throttle, and being rate
  // limited mid-connect looks to the customer like the connection failed.
  const businessIds = await listIds("me/businesses?fields=id&limit=50", token, fetchImpl, "reading businesses");
  const adAccountIds = await listIds("me/adaccounts?fields=id&limit=50", token, fetchImpl, "reading ad accounts");
  const pageIds = await listIds("me/accounts?fields=id&limit=50", token, fetchImpl, "reading Pages");

  // Instagram hangs off the Page, and only for Pages that have one linked.
  // A customer with no IG business account is normal, not an error.
  const instagramIds: string[] = [];
  for (const pageId of pageIds) {
    try {
      const res = await fetchImpl(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=instagram_business_account{id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = (await readJson(res, "reading Instagram")) as {
        instagram_business_account?: { id?: unknown };
      };
      const id = body.instagram_business_account?.id;
      if (typeof id === "string") instagramIds.push(id);
    } catch {
      // One Page without a readable IG link must not fail the whole connect.
      // instagram_basic is an optional scope precisely because this is normal.
    }
  }

  return { businessIds, adAccountIds, pageIds, instagramIds };
}

// An ad account grant is the one thing the product cannot work without: every
// campaign, ad set, ad and insight read is scoped to one. A connection without
// it would render as connected and fail on first use.
export async function completeOauth(
  config: OauthConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<ExchangeResult> {
  const accessToken = await exchangeCode(config, code, fetchImpl);
  const { metaUserId, scopes } = await inspectToken(config, accessToken, fetchImpl);
  const assets = await discoverAssets(accessToken, fetchImpl);
  if (!assets.adAccountIds.length) {
    throw new OauthRefusedError("no ad account was granted");
  }
  if (!assets.pageIds.length) {
    throw new OauthRefusedError("no Facebook Page was granted");
  }
  return { accessToken, scopes, assets: { ...assets, metaUserId } };
}
