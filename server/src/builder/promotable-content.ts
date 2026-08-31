import type { PromotablePost } from "./creative-types.js";

// AIC-156 — "content I already published", from BOTH networks.
//
// The picker used to read `{page}/posts` and only that, so a customer who
// connected their Instagram in the wizard saw none of their own Instagram
// content. Worse, `instagram_id` was stored, verified at onboarding and
// re-checked hourly by the health monitor, and then read by nothing at all.
//
// One module because the picker is one component (BuilderCreatives) reached
// from two screens — the first-campaign builder and add-content — behind two
// route paths. Three surfaces disagreeing about what "your posts" means is
// the AIC-155 shape exactly.

export interface PromotableReader {
  listPromotablePosts(pageId: string): Promise<PromotablePost[]>;
  listInstagramMedia(igUserId: string): Promise<PromotablePost[]>;
}

/**
 * Facebook Page posts plus Instagram media, newest first.
 *
 * INSTAGRAM FAILING MUST NOT COST THE FACEBOOK POSTS. The IG read is the new,
 * more fragile half — it needs `instagram_basic` (added to our System User
 * token on 2026-08-31) and an IG account that is still connected to the Page.
 * If a token is ever regenerated without that scope, or a customer
 * disconnects, the whole picker would go empty and the customer would be
 * unable to promote a Facebook post they have had for months. So the IG
 * failure is swallowed and logged; the Facebook failure still propagates,
 * because a Page is required for this flow to mean anything.
 *
 * No `instagram_id` on the connection is not an error — plenty of customers
 * have none. It just means no Instagram half.
 */
export async function listPromotableContent(
  reader: PromotableReader,
  pageId: string,
  igUserId: string | null | undefined,
): Promise<PromotablePost[]> {
  const posts = await reader.listPromotablePosts(pageId);
  if (!igUserId) return posts;

  let media: PromotablePost[] = [];
  try {
    media = await reader.listInstagramMedia(igUserId);
  } catch (e) {
    console.warn(`[builder] Instagram media unavailable for ${igUserId} — ${(e as Error).message}`);
  }

  // Newest first across BOTH networks rather than one list after the other:
  // the customer is looking for "the post I made last week", and they do not
  // think of it as a Facebook post or an Instagram post first. Missing or
  // unparseable timestamps sort last instead of throwing the order — Meta
  // returns ISO strings, but a blank must not become NaN and scramble the
  // list.
  const at = (p: PromotablePost): number => {
    const t = Date.parse(p.createdAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...posts, ...media].sort((a, b) => at(b) - at(a));
}
