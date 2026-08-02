// DB integration for the needs-attention queue (AIC-17). Requires DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("OpsQueue (DB)", () => {
  afterAll(async () => { await pool.end(); });

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
