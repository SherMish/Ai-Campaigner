// DB integration for the builder's idempotent creative-create step (AIC-51).
// Requires DATABASE_URL; self-skips otherwise. No real upload/network —
// FakeCreativeWriter stands in; the real adapter shape (base64 bytes, video
// polling, object_story_spec/object_story_id) is verified by
// campaign-adapter.test.ts.
import { describe, it, expect, afterAll } from "vitest";
import { FIXED_DESTINATION } from "@aic/shared";
import { pool } from "../db/pool.js";
import { startBuilderCampaign } from "./campaign-create.js";
import { createCreativeIdempotent, type CreativeSpec } from "./creative-create.js";
import { FakeCreativeWriter } from "./creative-types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCustomer(tag: string): Promise<{ customerId: string; adAccountId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ($1) RETURNING id`, [`__it_creative_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_crea_${conn.rows[0].id.slice(0, 8)}`]);
  return { customerId, adAccountId: acct.rows[0].id };
}

function uploadSpec(adAccountId: string): CreativeSpec {
  return {
    kind: "upload",
    adAccountId,
    pageId: "page_1",
    name: "Ad 1",
    headline: "מבצע קיץ",
    primaryText: "20% הנחה",
    whatsappNumber: "972500000000",
    media: { kind: "image", imageHash: "img_hash_1" },
    destination: FIXED_DESTINATION,
  };
}

function postSpec(adAccountId: string): CreativeSpec {
  return { kind: "existing_post", adAccountId, pageId: "page_1", name: "Ad 2", postId: "post_9" };
}

d("creative builder create-writes (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_creative_%'`);
    await pool.end();
  });

  it("upload path: creates a creative from uploaded media and logs the call", async () => {
    const { customerId, adAccountId } = await makeCustomer("upload");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeCreativeWriter();

    const creativeId = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId));

    expect(creativeId).toBeTruthy();
    expect(writer.uploadCreativeCalls).toHaveLength(1);
    expect(writer.uploadCreativeCalls[0].media).toEqual({ kind: "image", imageHash: "img_hash_1" });
    expect(writer.postCreativeCalls).toHaveLength(0);
  });

  it("existing-post path: creates a creative from a selected post, no upload fields involved", async () => {
    const { customerId, adAccountId } = await makeCustomer("post");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeCreativeWriter();

    const creativeId = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", postSpec(adAccountId));

    expect(creativeId).toBeTruthy();
    expect(writer.postCreativeCalls).toHaveLength(1);
    expect(writer.postCreativeCalls[0].postId).toBe("post_9");
    expect(writer.uploadCreativeCalls).toHaveLength(0);
  });

  it("is idempotent per clientKey: a repeat call with the same key never calls Meta again", async () => {
    const { customerId, adAccountId } = await makeCustomer("idem");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeCreativeWriter();

    const first = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId));
    const second = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId));

    expect(second).toBe(first);
    expect(writer.uploadCreativeCalls).toHaveLength(1);
  });

  it("a failure is reconcilable: retrying the same key succeeds and creates only one creative, never two", async () => {
    const { customerId, adAccountId } = await makeCustomer("resume");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeCreativeWriter();
    writer.failNextCreateFromUpload = 1;

    await expect(
      createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId)),
    ).rejects.toThrow("simulated Meta create-creative failure");
    expect(writer.uploadCreativeCalls).toHaveLength(0);

    const creativeId = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId));
    expect(creativeId).toBeTruthy();
    expect(writer.uploadCreativeCalls).toHaveLength(1);
  });

  it("different clientKeys within the same campaign create distinct creatives (e.g. 3-5 separate ads)", async () => {
    const { customerId, adAccountId } = await makeCustomer("multi");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeCreativeWriter();

    const a = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-1", uploadSpec(adAccountId));
    const b = await createCreativeIdempotent(pool, writer, localCampaignId, "adset-1-ad-2", uploadSpec(adAccountId));

    expect(a).not.toBe(b);
    expect(writer.uploadCreativeCalls).toHaveLength(2);
  });
});
