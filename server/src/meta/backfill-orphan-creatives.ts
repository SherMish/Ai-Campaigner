import "../load-env.js";
import { pool } from "../db/pool.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";

// AIC-131 one-off: adopt the ad creatives that leaked BEFORE created_creatives
// existed, so the reaper can clean them up.
//
// The reaper's safety boundary is "only ids we recorded". These predate the
// table, so they have no row and are invisible to it — correctly, since that
// boundary is what stops it touching a creative the customer made themselves.
// Adopting one means asserting we made it, which nothing in the data proves.
//
// THE FIRST VERSION OF THIS SCRIPT INFERRED IT, AND THE INFERENCE WAS WRONG.
// It adopted every orphan in every account we manage, on the reasoning that an
// account we manage contains creatives we made. The dry run listed 54, of which
// 33 were on a customer's own account and obviously theirs — ad copy from
// 2022-10, "AI Radar" creatives from 2025-03, the customer's own 2026-06
// campaigns. All predating this product. Applying it would have queued four
// years of a real business's advertising history for irreversible deletion.
//
// So ownership is now ASSERTED BY A HUMAN, never derived. BACKFILL_IDS is a
// comma-separated allowlist and nothing outside it is ever adopted. Without it
// the script only reports what it found, which is the form in which it is
// actually useful: a list for a person to read and choose from.
//
// It writes rows backdated past the age threshold, so the next reaper tick
// picks them up — with all three of the reaper's checks still applied,
// including a fresh in-use read at delete time. It never deletes anything
// itself.
async function main() {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN is required");
  // The allowlist. Nothing is adopted without appearing here — see the header:
  // deriving ownership from "it is orphaned in an account we manage" produced a
  // list containing a customer's own creatives going back to 2022.
  const allow = new Set(
    (process.env.BACKFILL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const apply = process.env.BACKFILL_APPLY === "1" && allow.size > 0;
  const only = process.env.BACKFILL_ACCOUNT; // optional: one account
  const adapter = new GraphCampaignAdapter(token);

  const { rows: accounts } = await pool.query<{ meta_ad_account_id: string }>(
    only
      ? `SELECT DISTINCT meta_ad_account_id FROM ad_accounts WHERE meta_ad_account_id = $1`
      : `SELECT DISTINCT meta_ad_account_id FROM ad_accounts`,
    only ? [only] : [],
  );

  for (const { meta_ad_account_id: acc } of accounts) {
    const [creatives, inUse] = await Promise.all([
      adapter.listAdCreatives(acc),
      adapter.listAdCreativeIdsInUse(acc),
    ]);
    const used = new Set(inUse);
    const orphans = creatives.filter((c) => !used.has(c.id));
    const { rows: known } = await pool.query<{ meta_creative_id: string }>(
      `SELECT meta_creative_id FROM created_creatives WHERE meta_ad_account_id = $1`,
      [acc],
    );
    const alreadyKnown = new Set(known.map((k) => k.meta_creative_id));
    const unrecorded = orphans.filter((c) => !alreadyKnown.has(c.id));
    const toAdopt = unrecorded.filter((c) => allow.has(c.id));

    console.log(
      `${acc}: ${creatives.length} creatives, ${inUse.length} in use, ` +
        `${orphans.length} orphaned, ${unrecorded.length} unrecorded, ${toAdopt.length} allowlisted`,
    );
    // Names are printed on one line each: several of these carry real ad copy
    // with newlines in it, and a multi-line entry in a list a human is about to
    // approve for deletion is genuinely dangerous — it hides how many rows
    // there are.
    for (const c of unrecorded) {
      const name = (c.name ?? "").replace(/\s+/g, " ").slice(0, 90);
      console.log(`   ${allow.has(c.id) ? "ADOPT " : "      "}${c.id}  ${name}`);
    }

    if (!apply || toAdopt.length === 0) continue;
    for (const c of toAdopt) {
      await pool.query(
        `INSERT INTO created_creatives (meta_creative_id, meta_ad_account_id, campaign_id, created_at)
         VALUES ($1, $2, NULL, now() - interval '30 days')
         ON CONFLICT (meta_creative_id) DO NOTHING`,
        [c.id, acc],
      );
    }
    console.log(`   adopted ${toAdopt.length} — the next reaper tick will delete them`);
  }
  if (apply) {
    console.log("[backfill] applied");
  } else if (allow.size === 0) {
    console.log(
      "[backfill] REPORT ONLY. Read the list above, decide which ids are OURS, " +
        "then re-run with BACKFILL_IDS=<comma-separated> BACKFILL_APPLY=1. " +
        "Ownership is never inferred — an orphan in a managed account may well " +
        "be the customer's own work.",
    );
  } else {
    console.log("[backfill] DRY RUN with an allowlist — add BACKFILL_APPLY=1 to write");
  }
  await pool.end();
}

main().catch((e) => { console.error("[backfill] failed", e); process.exit(1); });
