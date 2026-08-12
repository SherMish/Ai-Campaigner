import type pg from "pg";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { BuilderWriter } from "../builder/types.js";
import type { CreativeWriter } from "../builder/creative-types.js";
import type { AdditionWriter } from "./types.js";

// The inverse precondition of builder/session.ts's resolveBuilderContext:
// that one requires NO managed campaign (first-time build only); this one
// requires an EXISTING, linked campaign with a healthy connection — the
// normal P0 state for a customer we already manage.
export interface AdditionContext {
  customerId: string;
  localCampaignId: string;
  metaCampaignId: string;
  metaAdAccountId: string; // "act_..." — what every real Meta API call needs
  pageId: string;
  whatsappDestination: string;
  campaignName: string;
  category: string; // for the add-ad-set audience step's business-type prefill, same as the builder
}

export async function resolveAdditionContext(pool: pg.Pool, userId: string): Promise<AdditionContext | null> {
  const { rows } = await pool.query<{
    customer_id: string | null;
    category: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    meta_campaign_id: string | null;
    whatsapp_destination: string | null;
    access_health: string | null;
    meta_ad_account_id: string | null;
    page_id: string | null;
  }>(
    `SELECT u.customer_id, c.category, mc.id AS campaign_id, mc.name AS campaign_name,
            mc.meta_campaign_id, mc.whatsapp_destination,
            conn.access_health, aa.meta_ad_account_id, conn.page_id
     FROM app_users u
     LEFT JOIN customers c ON c.id = u.customer_id
     LEFT JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     LEFT JOIN meta_connections conn ON conn.customer_id = u.customer_id
     LEFT JOIN ad_accounts aa ON aa.connection_id = conn.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.customer_id || !r.campaign_id || !r.meta_campaign_id) return null;
  if (r.access_health !== "ok" || !r.meta_ad_account_id || !r.page_id) return null;
  return {
    customerId: r.customer_id,
    localCampaignId: r.campaign_id,
    metaCampaignId: r.meta_campaign_id,
    metaAdAccountId: r.meta_ad_account_id,
    pageId: r.page_id,
    whatsappDestination: r.whatsapp_destination ?? "",
    campaignName: r.campaign_name ?? "",
    category: r.category ?? "",
  };
}

// Same token-gated factory pattern as buildBuilderWriter/buildLaunchWriter.
export function buildAdditionWriter(): (BuilderWriter & CreativeWriter & AdditionWriter) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
