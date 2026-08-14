import { classifyGraphError, type GraphErrorBody } from "./errors.js";
import { extractLeads } from "./insights.js";
import type { Logger } from "../services/logger.js";

// AIC-1 live probe. Runs server-side (token stays in the process env, never
// leaves the server), logs a PASS/FAIL to the platform logs. READ-ONLY: lists the
// ad accounts the System User can reach (proves partner-access assignment), reads
// insights on one (proves ads_read + access tier), and reports the token's granted
// scopes (proves ads_management is present) — WITHOUT mutating anything. Gated by
// the META_PROBE env var; remove it after. An actual reversible write test is a
// separate, explicitly-approved step.
const BASE = "https://graph.facebook.com";

export async function runMetaProbe(log: Logger): Promise<void> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!token) {
    log.error("[meta-probe] META_SYSTEM_USER_TOKEN not set — cannot probe");
    return;
  }
  const H = { Authorization: `Bearer ${token}` };
  const get = async (url: string, init?: { headers?: Record<string, string> }) => {
    const r = await fetch(url, init);
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, body };
  };

  log.info("[meta-probe] ── AIC-1 probe starting ──");

  // 1) Ad accounts the System User can reach (proves partner-access assignment).
  const accts = await get(
    `${BASE}/${ver}/me/adaccounts?fields=id,name,account_status,currency,timezone_name&limit=25`,
    { headers: H },
  );
  if (!accts.ok) {
    const c = classifyGraphError(accts.status, accts.body as GraphErrorBody);
    log.error(`[meta-probe] LIST ad accounts FAILED → health=${c.health} :: ${c.detail}`);
    log.info("[meta-probe] RESULT=FAIL (token cannot list ad accounts)");
    return;
  }
  const list = (accts.body.data as Array<Record<string, unknown>>) ?? [];
  log.info(`[meta-probe] ${list.length} ad account(s) accessible:`);
  for (const a of list) {
    log.info(`[meta-probe]   ${a.id} — ${a.name} (status ${a.account_status}, ${a.currency})`);
  }

  // 2) Insights read on the first account (proves ads_read + access tier).
  let readOk = false;
  if (list.length > 0) {
    const act = String(list[0].id);
    const ins = await get(
      `${BASE}/${ver}/${act}/insights?fields=spend,impressions,actions&date_preset=last_7d`,
      { headers: H },
    );
    if (ins.ok) {
      readOk = true;
      const row = ((ins.body.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      // AIC-87: this is an ACCOUNT-level read (proves the token can read
      // Insights at all), not a single campaign's — there is no one
      // lead_event_types to apply here. Deliberately left on extractLeads'
      // WhatsApp default; the number is a smoke-test signal, not a real count.
      const leads = extractLeads(row.actions as never);
      log.info(`[meta-probe] INSIGHTS read OK on ${act}: spend=${row.spend ?? "0"} leads(7d, WhatsApp-default only)=${leads}`);
    } else {
      const c = classifyGraphError(ins.status, ins.body as GraphErrorBody);
      log.error(`[meta-probe] INSIGHTS read FAILED on ${act} → health=${c.health} :: ${c.detail}`);
    }
  }

  // 3) Token scopes (proves ads_management is granted for writes).
  let hasMgmt = false;
  if (appId && appSecret) {
    const dbg = await get(
      `${BASE}/${ver}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${appId}|${appSecret}`,
    );
    const scopes = ((dbg.body.data as Record<string, unknown>)?.scopes as string[]) ?? [];
    if (dbg.ok && scopes.length) {
      hasMgmt = scopes.includes("ads_management");
      log.info(`[meta-probe] token scopes: ${scopes.join(", ")}`);
      log.info(`[meta-probe] ads_read=${scopes.includes("ads_read")} ads_management=${hasMgmt}`);
    } else {
      log.error(`[meta-probe] debug_token failed (status ${dbg.status})`);
    }
  } else {
    log.info("[meta-probe] META_APP_ID/SECRET not both set — skipping scope check");
  }

  const pass = list.length > 0 && readOk && hasMgmt;
  log.info(
    `[meta-probe] RESULT=${pass ? "PASS" : "PARTIAL"} — accounts=${list.length} read=${readOk} ads_management=${hasMgmt}. ` +
      `Reads confirmed; an actual reversible write is the final AIC-1 confirmation.`,
  );
}
