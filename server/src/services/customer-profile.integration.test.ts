// AIC-138: the customer editing their OWN business profile from /app/settings.
//
// The point of this file is the whitelist. These fields are also writable by
// the admin console, whose writer additionally accepts isTest,
// onboardingStatus, agreedBudgetAgorot and per-account rule thresholds —
// reusing it behind a customer route would have handed a customer the ability
// to remove themselves from billing figures or retune their own engine by
// posting a field the UI never renders. The UI is not the boundary.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const app = createApp();

// Every customer this file creates, by id.
//
// Cleanup used to be `DELETE ... WHERE business_name LIKE '__it_prof_%'`, which
// is fine right up until a test CHANGES a business name — and one does: the
// mass-assignment test below renames the attacker's own row to "hacked", which
// is the correct outcome (they renamed themselves, not the victim). That row
// then no longer matched its own cleanup pattern, so every run leaked one
// orphan into the database. Two runs put two customers called "hacked" in
// production, counted as real because of the is_test flag below.
//
// Tracking ids makes cleanup independent of anything a test does to the row.
const seeded: string[] = [];

async function seed(tag: string) {
  const cust = await pool.query<{ id: string }>(
    // is_test TRUE: a leaked fixture must never be counted as a real customer
    // by growth stats or analytics. It was false, and that is what turned a
    // cleanup miss into wrong numbers rather than just junk.
    `INSERT INTO customers (business_name, category, is_test, onboarding_status)
     VALUES ($1,'מספרה',true,'call_scheduled') RETURNING id`,
    [`__it_prof_${tag}`],
  );
  const customerId = cust.rows[0].id;
  seeded.push(customerId);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_prof_${tag}@example.com`, customerId],
  );
  return { customerId, token: signAuthToken(user.rows[0].id) };
}

d("customer business profile (AIC-138)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-profile-at-least-32-chars-long"; });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_prof_%'`);
    // By id, not by name — see `seeded`. The LIKE is kept as a belt-and-braces
    // sweep for rows from older runs that predate this.
    await pool.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [seeded]);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_prof_%'`);
    await pool.end();
  });

  it("returns the caller's own profile, straight from the database", async () => {
    const { customerId, token } = await seed("read");
    await pool.query(
      `UPDATE customers SET differentiators = $2, objections = $3 WHERE id = $1`,
      [customerId, "12 שנות ניסיון", "חוששים מהמחיר"],
    );
    const res = await request(app).get("/api/app/profile").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.differentiators).toBe("12 שנות ניסיון");
    expect(res.body.objections).toBe("חוששים מהמחיר");
    expect(res.body.category).toBe("מספרה");
  });

  it("saves the editable fields", async () => {
    const { customerId, token } = await seed("write");
    const res = await request(app)
      .patch("/api/app/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ priceRange: "החל מ-₪250", leadFollowup: "חוזרים תוך שעה", copyConstraints: "בלי הבטחת תוצאה" });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT price_range, lead_followup, copy_constraints FROM customers WHERE id = $1`, [customerId]);
    expect(rows[0]).toEqual({
      price_range: "החל מ-₪250",
      lead_followup: "חוזרים תוך שעה",
      copy_constraints: "בלי הבטחת תוצאה",
    });
  });

  describe("the whitelist is the security boundary, not the UI", () => {
    it("IGNORES isTest — a customer cannot remove themselves from billing figures", async () => {
      // Sends FALSE, against a fixture seeded true. Two reasons:
      //
      //  * it is the dangerous direction, and the one this test is named for —
      //    a real customer flipping is_test to false→true would only remove
      //    themselves from billing, but true→false is how a test row would
      //    smuggle itself INTO the real figures;
      //  * it can actually fail. The old version sent `true` and asserted the
      //    row was still `false`. Once fixtures are seeded `true` (so a leaked
      //    one never pollutes real numbers), "unchanged" and "the write got
      //    through" are the same value, and the test proves nothing.
      const { customerId, token } = await seed("istest");
      const res = await request(app)
        .patch("/api/app/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ businessName: "__it_prof_istest", isTest: false });
      expect(res.status).toBe(200);

      const { rows } = await pool.query(`SELECT is_test FROM customers WHERE id = $1`, [customerId]);
      expect(rows[0].is_test).toBe(true);
    });

    it("IGNORES onboarding status — a customer cannot advance their own funnel state", async () => {
      const { customerId, token } = await seed("status");
      await request(app)
        .patch("/api/app/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ businessName: "__it_prof_status", onboardingStatus: "ready" });

      const { rows } = await pool.query(`SELECT onboarding_status FROM customers WHERE id = $1`, [customerId]);
      expect(rows[0].onboarding_status).toBe("call_scheduled");
    });

    it("IGNORES engine rule-threshold overrides", async () => {
      // The admin writer accepts these and they change which recommendations
      // the engine makes for this account. Not reachable from here.
      const { customerId, token } = await seed("thresholds");
      await request(app)
        .patch("/api/app/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ businessName: "__it_prof_thresholds", thresholdOverrides: { MIN_CREATIVE_SPEND_AGOROT: 1 } });

      // They live on managed_campaigns, which this route never touches at all
      // — it writes exactly one table, and that is itself part of the boundary.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM managed_campaigns
          WHERE customer_id = $1 AND threshold_overrides IS NOT NULL`, [customerId]);
      expect(rows[0].n).toBe(0);
    });

    it("cannot redirect the write at another customer, whatever the body says", async () => {
      const A = await seed("attacker");
      const B = await seed("victim");
      await request(app)
        .patch("/api/app/profile")
        .set("Authorization", `Bearer ${A.token}`)
        // Every id-shaped key an attacker might try. The customer is resolved
        // from the JWT by a JOIN, so none of these can reach B's row.
        .send({ businessName: "hacked", id: B.customerId, customerId: B.customerId, customer_id: B.customerId });

      const { rows } = await pool.query(`SELECT business_name FROM customers WHERE id = $1`, [B.customerId]);
      expect(rows[0].business_name).toBe("__it_prof_victim");
    });

    it("refuses to blank the business name", async () => {
      // It is how this customer appears everywhere including the ops console;
      // an empty one leaves an unidentifiable row.
      const { customerId, token } = await seed("blank");
      const res = await request(app)
        .patch("/api/app/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ businessName: "   " });
      expect(res.status).toBe(400);

      const { rows } = await pool.query(`SELECT business_name FROM customers WHERE id = $1`, [customerId]);
      expect(rows[0].business_name).toBe("__it_prof_blank");
    });

    it("401s without a token", async () => {
      const res = await request(app).patch("/api/app/profile").send({ businessName: "x" });
      expect(res.status).toBe(401);
    });
  });
});
