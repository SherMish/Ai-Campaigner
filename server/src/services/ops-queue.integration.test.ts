// DB integration for the needs-attention queue (AIC-17). Requires DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("OpsQueue (DB)", () => {
  afterAll(async () => {      // Safety net, added 2026-08-22. Cleanup used to live on the LAST LINE of
      // each test body, so any test that threw first leaked its customer row
      // permanently. That is not hypothetical: the failing drain-once test in
      // this suite leaked one row EVERY run, which is how 30 `__it_outbox`
      // customers accumulated in the shared production database — showing up
      // in the ops console as real customers, and feeding the unscoped drain
      // that poisoned a live customer's build.
      //
      // afterAll runs regardless of test outcome, so this cannot leak again.
      // Scoped to THIS file's own prefixes: suites run in parallel, and a
      // broader LIKE would delete a concurrently-running suite's rows.
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_ops%"]]);
 await pool.end(); });

  it("creates from each trigger, sorts high-severity first, and triages", async () => {
    const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_ops') RETURNING id`);
    const customerId = cust.rows[0].id;
    const q = new OpsQueue(pool);

    const low = await q.create({ customerId, type: "support_request", severity: "low", detail: "question" });
    const high = await q.create({ customerId, type: "meta_connection_failure", severity: "high", detail: "access lost" });
    await q.create({ customerId, type: "campaign_rejected", severity: "medium", detail: "rejected" });

    const list = (await q.list()).filter((i) => i.customerId === customerId);
    expect(list[0].severity).toBe("high"); // high first
    expect(list.map((i) => i.severity)).toEqual(["high", "medium", "low"]);

    // Claim → in_progress + claimed_by.
    const claimed = await q.claim(high.id, "liam");
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.claimedBy).toBe("liam");

    // Resolve → resolved + note, falls out of the default list.
    await q.resolve(low.id, "answered on WhatsApp");
    const afterResolve = (await q.list()).filter((i) => i.customerId === customerId);
    expect(afterResolve.some((i) => i.id === low.id)).toBe(false);
    const withResolved = (await q.list({ includeResolved: true })).filter((i) => i.customerId === customerId);
    expect(withResolved.find((i) => i.id === low.id)?.resolutionNote).toBe("answered on WhatsApp");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
