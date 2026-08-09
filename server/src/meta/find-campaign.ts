import { classifyGraphError, type GraphErrorBody } from "./errors.js";
import type { Logger } from "../services/logger.js";

// One-off READ-ONLY discovery (gated by META_FIND_CAMPAIGN): lists the campaigns
// under every ad account the System User can reach, so we can find a campaign by
// name (e.g. to repoint a managed_campaign at it). Logs id / account / currency /
// status / objective / daily_budget for each, and highlights any whose name
// contains META_FIND_CAMPAIGN_QUERY (default "GelNails"). Mutates nothing. Remove
// the env vars after reading the logs.
const BASE = "https://graph.facebook.com";

export async function findCampaign(log: Logger): Promise<void> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  const query = (process.env.META_FIND_CAMPAIGN_QUERY || "GelNails").toLowerCase();
  if (!token) {
    log.error("[find-campaign] META_SYSTEM_USER_TOKEN not set");
    return;
  }
  const H = { Authorization: `Bearer ${token}` };
  const get = async (url: string) => {
    const r = await fetch(url, { headers: H });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, body };
  };

  log.info(`[find-campaign] ── searching for "${query}" ──`);
  const accts = await get(
    `${BASE}/${ver}/me/adaccounts?fields=id,name,currency,account_status&limit=50`,
  );
  if (!accts.ok) {
    const c = classifyGraphError(accts.status, accts.body as GraphErrorBody);
    log.error(`[find-campaign] list ad accounts FAILED → ${c.health} :: ${c.detail}`);
    return;
  }
  const list = (accts.body.data as Array<Record<string, unknown>>) ?? [];
  log.info(`[find-campaign] ${list.length} ad account(s) reachable`);

  const matches: string[] = [];
  for (const a of list) {
    const act = String(a.id);
    const camps = await get(
      `${BASE}/${ver}/${act}/campaigns?fields=id,name,status,effective_status,objective,daily_budget&limit=200`,
    );
    if (!camps.ok) {
      const c = classifyGraphError(camps.status, camps.body as GraphErrorBody);
      log.error(`[find-campaign]   ${act} (${a.name}) — campaigns FAILED → ${c.health} :: ${c.detail}`);
      continue;
    }
    const rows = (camps.body.data as Array<Record<string, unknown>>) ?? [];
    log.info(`[find-campaign] ${act} — ${a.name} (${a.currency}): ${rows.length} campaign(s)`);
    for (const cmp of rows) {
      const line = `id=${cmp.id} name="${cmp.name}" status=${cmp.status}/${cmp.effective_status} objective=${cmp.objective} daily_budget=${cmp.daily_budget ?? "null"}`;
      log.info(`[find-campaign]   ${line}`);
      if (String(cmp.name ?? "").toLowerCase().includes(query)) {
        matches.push(`MATCH account=${act} currency=${a.currency} ${line}`);
      }
    }
  }

  if (matches.length === 0) {
    log.info(`[find-campaign] RESULT: no campaign matching "${query}" in any reachable account`);
  } else {
    log.info(`[find-campaign] RESULT: ${matches.length} match(es):`);
    for (const m of matches) log.info(`[find-campaign] >>> ${m}`);
  }
}
