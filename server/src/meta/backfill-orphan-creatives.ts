import "../load-env.js";
import { pool } from "../db/pool.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";

// AIC-131 one-off: adopt the ad creatives that leaked BEFORE created_creatives
// existed, so the reaper can clean them up.
//
// The reaper's safety boundary is "only ids we recorded". These predate the
// table, so they have no row and are invisible to it — correctly, since that
// boundary is what stops it touching a creative the customer made themselves.
// This script crosses that boundary deliberately and only on evidence:
//
//   - the account is one we manage (it comes from ad_accounts)
//   - the creative is referenced by NO ad in the account
//
// It writes rows backdated past the age threshold, so the next reaper tick
// picks them up — with all three of its checks still applied, including a fresh
// in-use read at delete time.
//
// DRY RUN BY DEFAULT. Set BACKFILL_APPLY=1 to write. It never deletes anything
// itself; deletion stays the reaper's job, through the reaper's own guards.
async function main() {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN is required");
  const apply = process.env.BACKFILL_APPLY === "1";
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
    const toAdopt = orphans.filter((c) => !alreadyKnown.has(c.id));

    console.log(
      `${acc}: ${creatives.length} creatives, ${inUse.length} in use, ` +
        `${orphans.length} orphaned, ${toAdopt.length} to adopt`,
    );
    for (const c of toAdopt) console.log(`   ${c.id}  ${c.name ?? ""}`);

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
  console.log(apply ? "[backfill] applied" : "[backfill] DRY RUN — set BACKFILL_APPLY=1 to write");
  await pool.end();
}

main().catch((e) => { console.error("[backfill] failed", e); process.exit(1); });
