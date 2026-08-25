import "../load-env.js";
import { pool } from "../db/pool.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";
import { buildReaperTick } from "../services/creative-reaper.js";
import { consoleLogger } from "../services/logger.js";

// AIC-131 one-off: run the reaper immediately instead of waiting for the hourly
// tick. Identical code path and identical guards — this only changes WHEN.
async function main() {
  const tick = await buildReaperTick(
    pool,
    () => {
      const token = process.env.META_SYSTEM_USER_TOKEN;
      return token ? new GraphCampaignAdapter(token) : null;
    },
    consoleLogger,
  );
  if (!tick) throw new Error("META_SYSTEM_USER_TOKEN is required");
  const r = await tick();
  console.log(`considered ${r.considered} | deleted ${r.deleted.length} | in use ${r.reattached.length} | failed ${r.failed.length}`);
  for (const f of r.failed) console.log(`  FAILED ${f.creativeId}: ${f.error}`);
  await pool.end();
}
main().catch((e) => { console.error("[reaper-once] failed", e); process.exit(1); });
