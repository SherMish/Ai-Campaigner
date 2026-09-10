import "../load-env.js";
import { pool } from "../db/pool.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";
import { tokenForAdAccount } from "./token-resolver.js";
import { buildReaperTick } from "../services/creative-reaper.js";
import { consoleLogger } from "../services/logger.js";

// AIC-131 one-off: run the reaper immediately instead of waiting for the hourly
// tick. Identical code path and identical guards — this only changes WHEN.
async function main() {
  const tick = await buildReaperTick(
    pool,
    // AIC-187: the same resolver the scheduled tick uses, so this one-off
    // stays "identical code path, only WHEN differs" — including whose
    // credential each account is reaped with.
    async (adAccountId) => {
      const resolved = await tokenForAdAccount(pool, adAccountId);
      return resolved ? new GraphCampaignAdapter(resolved.token) : null;
    },
    consoleLogger,
  );
  if (!tick) throw new Error("could not build a reaper tick");
  const r = await tick();
  console.log(`considered ${r.considered} | deleted ${r.deleted.length} | in use ${r.reattached.length} | failed ${r.failed.length}`);
  for (const f of r.failed) console.log(`  FAILED ${f.creativeId}: ${f.error}`);
  await pool.end();
}
main().catch((e) => { console.error("[reaper-once] failed", e); process.exit(1); });
