// Unit tests for GraphCampaignAdapter's create-writes (AIC-50) — the hard
// rule this ticket exists to enforce: every object the builder creates lands
// ACTIVE from creation (AIC-106). Mocks global fetch (no other GraphCampaignAdapter
// method has a unit test today — every prior write was verified via a live
// reversible dogfood test instead; this one gets a unit test too because the
// paused-invariant is safety-critical and cheap to pin down here directly).
import { describe, it, expect, vi, afterEach } from "vitest";
import { FIXED_DESTINATION, FIXED_CTA, WEBSITE_DESTINATION, WEBSITE_CTA, ENGAGEMENT_DESTINATION } from "@aic/shared";
import { GraphCampaignAdapter, GraphWriteError } from "./campaign-adapter.js";

function fakeFetch(respond: { id: string }) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    return {
      ok: true,
      status: 200,
      json: async () => respond,
      __body: body, // stashed for assertions below
    } as unknown as Response & { __body: URLSearchParams };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// AIC-105's "Meta API failure" error category, built against a real live
// case rather than an invented shape — found today, 2026-08-19, on a real
// customer's WhatsApp campaign build: Meta refused ad set creation with a
// clear, actionable reason (Page not linked to a WhatsApp Business Account),
// and the code discarded it into a generic "failed to build campaign".
// Scoped narrowly and deliberately: this surfaces Meta's OWN
// error_user_title/error_user_msg when present, rather than building
// AIC-105's full four-category translation table (still not done).
function fakeGraphErrorFetch(errorBody: Record<string, unknown>, status = 400) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ error: errorBody }),
  })) as unknown as typeof fetch;
}

describe("GraphWriteError — Meta's own actionable message, not a raw code", () => {
  const REAL_WHATSAPP_PAGE_ERROR = {
    message: "Invalid parameter",
    type: "OAuthException",
    code: 100,
    error_subcode: 2446886,
    is_transient: false,
    error_user_title: "Page With WhatsApp Business Account Required",
    error_user_msg: "Your Page is not linked to a WhatsApp account. Connect a WhatsApp Business account to drive traffic to WhatsApp.",
    fbtrace_id: "AZgEpNwfQv5wPDqsYZ3os4p",
  };

  it("createAdSet throws GraphWriteError carrying Meta's own user-facing title+message", async () => {
    vi.stubGlobal("fetch", fakeGraphErrorFetch(REAL_WHATSAPP_PAGE_ERROR));
    const adapter = new GraphCampaignAdapter("tok");

    let caught: unknown;
    try {
      await adapter.createAdSet({
        adAccountId: "act_1", metaCampaignId: "camp_1", name: "Adset 1",
        targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
        pageId: "page_1", destination: FIXED_DESTINATION,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(GraphWriteError);
    const err = caught as GraphWriteError;
    expect(err.userTitle).toBe("Page With WhatsApp Business Account Required");
    expect(err.userMessage).toBe(
      "Your Page is not linked to a WhatsApp account. Connect a WhatsApp Business account to drive traffic to WhatsApp.",
    );
    expect(err.isTransient).toBe(false);
    expect(err.code).toBe(100);
    expect(err.subcode).toBe(2446886);
  });

  it("still throws a plain Error when Meta gives no user-facing fields (nothing to surface)", async () => {
    vi.stubGlobal("fetch", fakeGraphErrorFetch({ message: "Unknown error", type: "OAuthException", code: 1 }));
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.createAdSet({
      adAccountId: "act_1", metaCampaignId: "camp_1", name: "Adset 1",
      targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
      pageId: "page_1", destination: FIXED_DESTINATION,
    })).rejects.not.toBeInstanceOf(GraphWriteError);
  });
});

// AIC-106 removed the launch gate: creation IS the go-live moment, so these
// assertions flipped from PAUSED to ACTIVE. This is the single most
// consequential line in the file — it is where money starts moving — so it is
// asserted explicitly on all three creates rather than inferred.
describe("GraphCampaignAdapter create-writes — ACTIVE on create (AIC-106)", () => {
  it("createCampaign sends status=ACTIVE and the campaign fields", async () => {
    const mock = fakeFetch({ id: "meta_camp_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createCampaign({
      adAccountId: "act_123", name: "Test", dailyBudgetAgorot: 4000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP", destination: "whatsapp",
    });

    expect(id).toBe("meta_camp_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/campaigns");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("ACTIVE");
    expect(body.get("objective")).toBe("OUTCOME_LEADS");
    expect(body.get("daily_budget")).toBe("4000");
  });

  it("createAdSet sends status=ACTIVE and is created on the ad account's edge with campaign_id in the body", async () => {
    const mock = fakeFetch({ id: "meta_adset_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createAdSet({
      adAccountId: "act_123", metaCampaignId: "meta_camp_1", name: "Adset",
      targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
      pageId: "page_1",
      destination: FIXED_DESTINATION,
    });

    expect(id).toBe("meta_adset_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/adsets");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("ACTIVE");
    expect(body.get("campaign_id")).toBe("meta_camp_1");
    expect(JSON.parse(body.get("targeting") ?? "{}")).toMatchObject({ age_min: 18, age_max: 45 });
    // Meta REFUSES the create if this is absent — an explicit 0 or 1 is
    // mandatory (found live 2026-08-19 mid-build). Asserted as 0 specifically:
    // the wizard tells the customer the campaign targets a stated age range
    // and gender, and Advantage audience would let Meta deliver outside it,
    // making that promise untrue. Flipping this is a copy change first.
    expect(JSON.parse(body.get("targeting") ?? "{}").targeting_automation)
      .toEqual({ advantage_audience: 0 });
    // AIC-89 sub-fix: these come from resolveDestinationShape(FIXED_DESTINATION),
    // not an inline literal — the exact fields a Pixel destination must NOT get.
    expect(body.get("optimization_goal")).toBe("CONVERSATIONS");
    expect(body.get("destination_type")).toBe("WHATSAPP");
  });

  it("createAdSet REFUSES an unrecognized destination rather than silently emitting the WhatsApp shape", async () => {
    const mock = fakeFetch({ id: "meta_adset_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(
      adapter.createAdSet({
        adAccountId: "act_123", metaCampaignId: "meta_camp_1", name: "Adset",
        targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
        pageId: "page_1",
        destination: "something_unrecognized",
      }),
    ).rejects.toThrow(/something_unrecognized/);
    expect(mock).not.toHaveBeenCalled();
  });

  // AIC-89: createAdSet now builds the full website-destination shape,
  // including promoted_object — the create-path counterpart to AIC-102's
  // creative fix. pixelId/conversionEvent replace page_id in promoted_object
  // ONLY for the website destination; a WhatsApp ad set (test above) is
  // completely unaffected.
  it("createAdSet builds pixel_id/custom_event_type promoted_object for the website destination", async () => {
    const mock = fakeFetch({ id: "meta_adset_2" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createAdSet({
      adAccountId: "act_123", metaCampaignId: "meta_camp_1", name: "Adset",
      targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
      pageId: "page_1",
      destination: WEBSITE_DESTINATION,
      pixelId: "984664453249037",
      conversionEvent: "COMPLETE_REGISTRATION",
    });

    expect(id).toBe("meta_adset_2");
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("optimization_goal")).toBe("OFFSITE_CONVERSIONS");
    expect(body.get("destination_type")).toBe("WEBSITE");
    expect(JSON.parse(body.get("promoted_object") ?? "{}")).toEqual({
      pixel_id: "984664453249037",
      custom_event_type: "COMPLETE_REGISTRATION",
    });
  });

  it("createAd sends status=ACTIVE and is created on the ad account's edge with adset_id + creative in the body", async () => {
    const mock = fakeFetch({ id: "meta_ad_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createAd({
      adAccountId: "act_123", metaAdSetId: "meta_adset_1", name: "Ad", creativeId: "crea_1",
    });

    expect(id).toBe("meta_ad_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/ads");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("ACTIVE");
    expect(body.get("adset_id")).toBe("meta_adset_1");
    expect(JSON.parse(body.get("creative") ?? "{}")).toEqual({ creative_id: "crea_1" });
  });

  it("throws with the Meta error body when a create call fails, instead of returning a fabricated id", async () => {
    const mock = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: "Invalid parameter" } }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.createCampaign({
      adAccountId: "act_123", name: "Test", dailyBudgetAgorot: 4000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP", destination: "whatsapp",
    })).rejects.toThrow(/Invalid parameter/);
  });

  // AIC-107: the objective now comes from the destination shape. Before this,
  // "OUTCOME_LEADS" was an inline literal here while FIXED_OBJECTIVE sat
  // unused — so an engagement campaign would have been created on Meta as a
  // Leads campaign, and every downstream number would have described the
  // wrong thing.
  it("createCampaign sends the objective its destination implies — engagement is NOT created as Leads", async () => {
    const mock = fakeFetch({ id: "meta_camp_eng" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCampaign({
      adAccountId: "act_123", name: "Engagement test", dailyBudgetAgorot: 2000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP", destination: "engagement",
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    expect(body).toContain("OUTCOME_ENGAGEMENT");
    expect(body).not.toContain("OUTCOME_LEADS");
  });

  it("REGRESSION: a whatsapp campaign is still created as OUTCOME_LEADS", async () => {
    const mock = fakeFetch({ id: "meta_camp_wa" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCampaign({
      adAccountId: "act_123", name: "WA test", dailyBudgetAgorot: 2000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP", destination: "whatsapp",
    });

    const [, waInit] = mock.mock.calls[0] as [string, RequestInit];
    expect(String(waInit.body)).toContain("OUTCOME_LEADS");
  });
});

// AIC-89 — the website-destination builder step's Pixel picker + recency guard.
describe("GraphCampaignAdapter Pixel discovery + recency (AIC-89)", () => {
  it("listPixels returns every Pixel on the ad account", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "984664453249037", name: "Pisga Pixel" }, { id: "111", name: "" }] }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const pixels = await adapter.listPixels("act_123");

    expect(pixels).toEqual([
      { id: "984664453249037", name: "Pisga Pixel" },
      { id: "111", name: "111" }, // falls back to the id when Meta returns no name
    ]);
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("act_123/adspixels");
  });

  it("checkPixelEventRecency reports true when the chosen event has recent volume", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { data: [{ value: "PageView", count: 40 }, { value: "CompleteRegistration", count: 3 }] },
          { data: [{ value: "CompleteRegistration", count: 2 }] },
        ],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const result = await adapter.checkPixelEventRecency("984664453249037", "CompleteRegistration");
    expect(result).toEqual({ hasRecentEvents: true });
  });

  it("checkPixelEventRecency reports false — never null — when the event genuinely has zero recent volume", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ data: [{ value: "CompleteRegistration", count: 0 }] }] }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.checkPixelEventRecency("984664453249037", "CompleteRegistration")).toEqual({ hasRecentEvents: false });
  });

  it("checkPixelEventRecency reports false when the event never appears in the response at all", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ data: [{ value: "PageView", count: 40 }] }] }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.checkPixelEventRecency("984664453249037", "CompleteRegistration")).toEqual({ hasRecentEvents: false });
  });

  it("REGRESSION: checkPixelEventRecency reports null (never a confident false) on a network/read failure", async () => {
    const mock = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.checkPixelEventRecency("984664453249037", "CompleteRegistration")).toEqual({ hasRecentEvents: null });
  });
});

describe("GraphCampaignAdapter creative handling (AIC-51)", () => {
  it("uploadImage sends the file as base64 bytes and parses the returned hash", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200,
      json: async () => ({ images: { "photo.jpg": { hash: "img_hash_1", url: "https://x/photo.jpg" } } }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");
    const fileBuffer = Buffer.from("fake image bytes");

    const result = await adapter.uploadImage("act_123", fileBuffer, "photo.jpg");

    expect(result).toEqual({ hash: "img_hash_1", url: "https://x/photo.jpg" });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/adimages");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("bytes")).toBe(fileBuffer.toString("base64"));
  });

  it("uploadImage throws honestly (never a fabricated hash) when Meta rejects the file", async () => {
    const mock = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: { message: "Unsupported image type" } }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");
    await expect(adapter.uploadImage("act_123", Buffer.from("x"), "bad.txt")).rejects.toThrow(/Unsupported image type/);
  });

  it("uploadVideo posts multipart form data, polls until Meta reports ready, and returns the thumbnail", async () => {
    let pollCount = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/advideos")) {
        expect(init?.body).toBeInstanceOf(FormData);
        return { ok: true, status: 200, json: async () => ({ id: "vid_1" }) } as unknown as Response;
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, status: 200, json: async () => ({ status: { video_status: "processing" } }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ status: { video_status: "ready" }, picture: "https://x/thumb.jpg" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok", undefined, 0); // 0ms poll delay — no real waiting in the test

    const result = await adapter.uploadVideo("act_123", Buffer.from("fake video bytes"), "clip.mp4");

    expect(result).toEqual({ videoId: "vid_1", thumbnailUrl: "https://x/thumb.jpg" });
    expect(pollCount).toBe(2); // processing once, then ready
  });

  it("uploadVideo throws honestly if Meta reports the video failed processing", async () => {
    const mock = vi.fn(async (url: string) => {
      if (String(url).includes("/advideos")) return { ok: true, status: 200, json: async () => ({ id: "vid_1" }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ status: { video_status: "error" } }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok", undefined, 0);
    await expect(adapter.uploadVideo("act_123", Buffer.from("x"), "clip.mp4")).rejects.toThrow(/failed processing/);
  });

  it("uploadVideo gives up honestly after the poll budget is exhausted rather than hanging forever", async () => {
    const mock = vi.fn(async (url: string) => {
      if (String(url).includes("/advideos")) return { ok: true, status: 200, json: async () => ({ id: "vid_1" }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ status: { video_status: "processing" } }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok", undefined, 0);
    await expect(adapter.uploadVideo("act_123", Buffer.from("x"), "clip.mp4")).rejects.toThrow(/did not finish processing/);
  });

  // Verified live 2026-08-12 against the real "Byliam nails" Page:
  //  - `/{page}/promotable_posts` does NOT exist ("(#100) Tried accessing
  //    nonexisting field") with EITHER a System User or a Page token
  //  - `/{page}/posts` works, but ONLY with the Page's own access token
  //    (System User token → 190/2069032 "A Page access token is required")
  // The previous version of this test asserted the promotable_posts URL and
  // passed against a mock, which is exactly why the broken endpoint shipped.
  it("listPromotablePosts fetches the Page token, then reads /posts WITH it", async () => {
    const mock = vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: true, status: 200,
      json: async () =>
        url.includes("me/accounts")
          ? { data: [{ id: "page_1", access_token: "PAGE_TOKEN" }] }
          : { data: [{ id: "post_1", message: "hello", full_picture: "https://x/p.jpg", created_time: "2026-08-01T00:00:00Z" }] },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("SYSTEM_TOKEN");

    const posts = await adapter.listPromotablePosts("page_1");

    // AIC-156: `source` tags where each item came from — the picker now shows
    // both networks, and the tag selects the Meta creative shape later.
    expect(posts).toEqual([{ id: "post_1", message: "hello", pictureUrl: "https://x/p.jpg", createdAt: "2026-08-01T00:00:00Z", source: "facebook" }]);

    const [tokenUrl, tokenInit] = mock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toContain("me/accounts");
    expect((tokenInit.headers as Record<string, string>).Authorization).toBe("Bearer SYSTEM_TOKEN");

    const [postsUrl, postsInit] = mock.mock.calls[1] as [string, RequestInit];
    expect(postsUrl).toContain("page_1/posts");
    expect(postsUrl).not.toContain("promotable_posts");
    // the Page token, NOT the System User token — the whole point
    expect((postsInit.headers as Record<string, string>).Authorization).toBe("Bearer PAGE_TOKEN");
  });

  it("REGRESSION (found live 2026-08-17): strips Meta's own compound page_post id down to the bare post id", async () => {
    // Meta's real /posts edge returns id as "{page-id}_{post-id}", not bare —
    // confirmed against the live API. Passing that straight through as
    // `postId` made createCreativeFromExistingPost double-prefix it into
    // "page_1_page_1_post_1", which Meta rejected with (#100) Invalid
    // post_id parameter, surfaced to the customer as a raw 502.
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        url.includes("me/accounts")
          ? { data: [{ id: "page_1", access_token: "PAGE_TOKEN" }] }
          : { data: [{ id: "page_1_post_1", message: "hello", full_picture: null, created_time: "2026-08-17T00:00:00Z" }] },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("SYSTEM_TOKEN");

    const posts = await adapter.listPromotablePosts("page_1");

    expect(posts[0].id).toBe("post_1");
  });

  it("listPromotablePosts fails honestly when the Page isn't assigned to the System User", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200, json: async () => ({ data: [] }), // no Pages reachable
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.listPromotablePosts("page_1")).rejects.toThrow(/not assigned to this System User/);
  });

  it("createCreativeFromUpload sends a WhatsApp object_story_spec referencing the uploaded image", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_1" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createCreativeFromUpload({
      adAccountId: "act_123", pageId: "page_1", name: "Ad 1",
      headline: "מבצע קיץ", primaryText: "20% הנחה",
      whatsappNumber: "972500000000",
      media: { kind: "image", imageHash: "img_hash_1" },
      destination: FIXED_DESTINATION,
    });

    expect(id).toBe("crea_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/adcreatives");
    const body = new URLSearchParams(String(init.body));
    const spec = JSON.parse(body.get("object_story_spec") ?? "{}");
    expect(spec.page_id).toBe("page_1");
    expect(spec.link_data.image_hash).toBe("img_hash_1");
    // AIC-89 sub-fix: sourced from resolveDestinationShape(FIXED_DESTINATION)
    // via FIXED_CTA, not an inline "WHATSAPP_MESSAGE" literal.
    expect(spec.link_data.call_to_action).toEqual({ type: FIXED_CTA, value: { whatsapp_number: "972500000000" } });
  });

  // AIC-102: the website/Pixel destination's counterpart to the WhatsApp test
  // above — Pisga's own free_beta_signups_leads campaign needed exactly this
  // shape (a link CTA, no phone number) to add content to its own campaign.
  it("createCreativeFromUpload sends a link-based object_story_spec for the website destination", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_3" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createCreativeFromUpload({
      adAccountId: "act_123", pageId: "page_1", name: "Ad 1",
      headline: "הרשמה עכשיו", primaryText: "לחצו כדי להירשם",
      whatsappNumber: "",
      destinationUrl: "https://pisga.app/signup",
      media: { kind: "image", imageHash: "img_hash_1" },
      destination: WEBSITE_DESTINATION,
    });

    expect(id).toBe("crea_3");
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    const spec = JSON.parse(body.get("object_story_spec") ?? "{}");
    expect(spec.link_data.image_hash).toBe("img_hash_1");
    expect(spec.link_data.link).toBe("https://pisga.app/signup");
    expect(spec.link_data.call_to_action).toEqual({ type: WEBSITE_CTA, value: { link: "https://pisga.app/signup" } });
    // Never leaks a WhatsApp field into a website-shaped creative.
    expect(spec.link_data.call_to_action.value.whatsapp_number).toBeUndefined();
  });

  it("createCreativeFromUpload REFUSES an unrecognized destination rather than silently emitting a WhatsApp CTA", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_1" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(
      adapter.createCreativeFromUpload({
        adAccountId: "act_123", pageId: "page_1", name: "Ad 1",
        headline: "מבצע קיץ", primaryText: "20% הנחה",
        whatsappNumber: "",
        media: { kind: "image", imageHash: "img_hash_1" },
        destination: "something_unrecognized",
      }),
    ).rejects.toThrow(/something_unrecognized/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("createCreativeFromExistingPost sends object_story_id (page_post) — no upload fields at all", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_2" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createCreativeFromExistingPost({ adAccountId: "act_123", pageId: "page_1", name: "Ad 2", postId: "post_9" });

    expect(id).toBe("crea_2");
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("object_story_id")).toBe("page_1_post_9");
    expect(body.has("object_story_spec")).toBe(false);
  });

  // ── AIC-156: the Instagram identity, and Instagram posts ────────────────

  it("an Instagram post uses object_id + source_instagram_media_id, NOT object_story_id", async () => {
    // Meta's "Use Posts as Instagram Ads" guide: the Instagram path takes the
    // bare PAGE id as object_id plus the media id, where the Facebook path
    // takes a compound "{page}_{post}" story id. Sending object_story_id with
    // an IG media id would build a creative pointing at a Facebook post that
    // does not exist.
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_ig" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({
      adAccountId: "act_123", pageId: "page_1", name: "IG ad",
      postId: "17917607970159179", postSource: "instagram", instagramUserId: "17841446168726181",
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("object_id")).toBe("page_1");
    expect(body.get("source_instagram_media_id")).toBe("17917607970159179");
    expect(body.get("instagram_user_id")).toBe("17841446168726181");
    expect(body.has("object_story_id")).toBe(false);
  });

  it("REFUSES an Instagram post with no Instagram identity, before any Meta call", async () => {
    // There is no shadow-profile fallback for content that lives on a real
    // account. Refused here so the failure names the missing thing, instead of
    // arriving as a Meta 400 the customer sees as a raw 502.
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(
      adapter.createCreativeFromExistingPost({
        adAccountId: "act_123", pageId: "page_1", name: "IG ad",
        postId: "media_1", postSource: "instagram",
      }),
    ).rejects.toThrow(/instagramUserId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("a Facebook post carries the Instagram identity when we have one", async () => {
    // THE HALF THAT CHANGES WHAT CUSTOMERS GET. Without instagram_user_id Meta
    // still serves Instagram placements — under the Page-backed shadow
    // profile, which has no username. So a customer connected their Instagram
    // and their ads ran as somebody else.
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_fb" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({
      adAccountId: "act_123", pageId: "page_1", name: "FB ad",
      postId: "post_9", postSource: "facebook", instagramUserId: "17841446168726181",
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("object_story_id")).toBe("page_1_post_9");
    expect(body.get("instagram_user_id")).toBe("17841446168726181");
  });

  it("omits instagram_user_id entirely when the connection has none", async () => {
    // Never an empty string: Meta reads a blank as a value, and a customer
    // with no Instagram must produce the byte-identical payload we sent before.
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_fb2" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({ adAccountId: "act_123", pageId: "page_1", name: "Ad", postId: "post_9" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("instagram_user_id")).toBe(false);
  });

  it("asks for boost_eligibility_info BARE — a bad subfield fails the whole call", async () => {
    // Found live: `boost_eligibility_info{eligible_to_boost,eligibility_errors}`
    // is rejected with "(#100) Tried accessing nonexisting field" on v21.0,
    // and that takes EVERY post down with it, emptying the Instagram half for
    // every customer.
    const mock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    await new GraphCampaignAdapter("tok").listInstagramMedia("ig_1");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("boost_eligibility_info&");
    expect(url).not.toContain("eligibility_errors");
  });

  it("listInstagramMedia carries Meta's own boost-eligibility verdict", async () => {
    const mock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ data: [
      { id: "m1", caption: "Just like candy", media_type: "IMAGE", media_url: "https://x/1.jpg", timestamp: "2026-08-20T00:00:00Z" },
      { id: "m2", media_type: "VIDEO", media_url: "https://x/2.mp4", thumbnail_url: "https://x/2.jpg", timestamp: "2026-08-21T00:00:00Z",
        boost_eligibility_info: { eligible_to_boost: false, eligibility_errors: [{ error_message: "licensed music" }] } },
    ] }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const media = await adapter.listInstagramMedia("ig_1");

    expect(media[0]).toMatchObject({ id: "m1", source: "instagram", boostable: true, pictureUrl: "https://x/1.jpg" });
    // A video's media_url is the video FILE — the thumbnail is what belongs in
    // an <img>.
    expect(media[1].pictureUrl).toBe("https://x/2.jpg");
    expect(media[1]).toMatchObject({ boostable: false, boostReason: "licensed music" });
  });

  it("treats an ABSENT eligibility verdict as boostable, not as blocked", async () => {
    // Meta not saying is not Meta saying no. Blocking on silence would hide
    // perfectly promotable posts.
    const mock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({
      data: [{ id: "m3", media_type: "IMAGE", media_url: "https://x/3.jpg", timestamp: "2026-08-22T00:00:00Z" }],
    }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect((await adapter.listInstagramMedia("ig_1"))[0].boostable).toBe(true);
  });

  // Found live 2026-08-23: a real build failed at create_ad with "The ad's
  // creative is incompatible with the objective of the campaign the ad belongs
  // to." This path sent ONLY object_story_id, so the creative carried no CTA,
  // and a click-to-WhatsApp campaign requires one.
  //
  // The code comment here read "Meta reuses whatever CTA/link the original Page
  // post already has" — true of what happens when you send nothing, but it was
  // mistaken for a LIMIT. Probed against the real ad account: Meta accepts
  // `call_to_action` alongside `object_story_id`, and it persists
  // (`call_to_action_type: WHATSAPP_MESSAGE` read back). The post never needed
  // its own CTA — we needed to attach one.
  it("attaches the destination's CTA so the creative matches the campaign objective", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_wa" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({
      adAccountId: "act_123", pageId: "page_1", name: "Ad", postId: "post_9",
      destination: FIXED_DESTINATION, whatsappNumber: "972500000000",
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const cta = JSON.parse(new URLSearchParams(String(init.body)).get("call_to_action") ?? "{}");
    expect(cta.type).toBe(FIXED_CTA);
    expect(cta.value.whatsapp_number).toBe("972500000000");
  });

  it("uses the WEBSITE cta shape for a website campaign", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_web" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({
      adAccountId: "act_123", pageId: "page_1", name: "Ad", postId: "post_9",
      destination: WEBSITE_DESTINATION, destinationUrl: "https://example.com/x",
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const cta = JSON.parse(new URLSearchParams(String(init.body)).get("call_to_action") ?? "{}");
    expect(cta.type).toBe(WEBSITE_CTA);
    expect(cta.value.link).toBe("https://example.com/x");
  });

  // Engagement promotes the post AS IS — the interaction happens on the post
  // itself, so imposing a CTA would change what the customer chose to run.
  it("sends NO call_to_action for an engagement campaign", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_eng" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({
      adAccountId: "act_123", pageId: "page_1", name: "Ad", postId: "post_9",
      destination: ENGAGEMENT_DESTINATION,
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("call_to_action")).toBe(false);
  });

  // Unchanged behaviour for callers that pass no destination (older call
  // sites): send object_story_id alone, exactly as before.
  it("omits the CTA entirely when no destination is given", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ id: "crea_bare" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.createCreativeFromExistingPost({ adAccountId: "act_123", pageId: "page_1", name: "Ad", postId: "post_9" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("call_to_action")).toBe(false);
  });
});

describe("GraphCampaignAdapter launch gate (AIC-53)", () => {
  it("getCampaignStatus returns the CONFIGURED status, not effective_status", async () => {
    const mock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ status: "PAUSED", effective_status: "ACTIVE" }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const status = await adapter.getCampaignStatus("meta_camp_1");

    expect(status).toBe("PAUSED");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("fields=status,effective_status");
  });

  it("activateCampaign always sends status=ACTIVE, never a caller-supplied value", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.activateCampaign("meta_camp_1");

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("meta_camp_1");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("ACTIVE");
  });

  it("activateCampaign throws honestly (never a silent success) when Meta rejects it", async () => {
    const mock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Cannot activate" } }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.activateCampaign("meta_camp_1")).rejects.toThrow(/Cannot activate/);
  });
});

describe("GraphCampaignAdapter add-to-existing-campaign (AIC-63)", () => {
  it("getAdSetStatus / getAdStatus return the configured status", async () => {
    const mock = vi.fn(async (url: string) =>
      ({ ok: true, status: 200, json: async () => ({ status: String(url).includes("as_1") ? "ACTIVE" : "PAUSED" }) } as unknown as Response),
    );
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.getAdSetStatus("as_1")).toBe("ACTIVE");
    expect(await adapter.getAdStatus("ad_1")).toBe("PAUSED");
  });

  // REGRESSION (live incident 2026-08-12): a real customer paused a real ad,
  // Meta applied it, but `effective_status` still read ACTIVE moments later —
  // read-back verification failed and the app told them it hadn't worked when
  // it had. Reading the configured `status` is immediate and authoritative.
  it("read-back is immune to effective_status lag right after a write", async () => {
    const mock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ status: "PAUSED", effective_status: "ACTIVE" }) } as unknown as Response),
    );
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.getAdStatus("ad_1")).toBe("PAUSED");
  });

  // An ad inside a paused ad set reports effective_status ADSET_PAUSED even
  // when the ad itself is ACTIVE — verifying against it would false-fail
  // forever, not just transiently.
  it("a parent's paused state never masks the object's own status", async () => {
    const mock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ status: "ACTIVE", effective_status: "ADSET_PAUSED" }) } as unknown as Response),
    );
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.getAdStatus("ad_1")).toBe("ACTIVE");
  });

  it("activateAdSet always sends status=ACTIVE, never a caller-supplied value", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.activateAdSet("as_1");

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("as_1");
    expect(new URLSearchParams(String(init.body)).get("status")).toBe("ACTIVE");
  });

  it("activateAd always sends status=ACTIVE, never a caller-supplied value", async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await adapter.activateAd("ad_1");

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("ad_1");
    expect(new URLSearchParams(String(init.body)).get("status")).toBe("ACTIVE");
  });

  it("activateAdSet/activateAd throw honestly when Meta rejects them", async () => {
    const mock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Cannot activate" } }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.activateAdSet("as_1")).rejects.toThrow(/Cannot activate/);
    await expect(adapter.activateAd("ad_1")).rejects.toThrow(/Cannot activate/);
  });

  it("getAdSetMeta includes effective_status in the requested fields", async () => {
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "as_1", name: "Set A", effective_status: "ACTIVE", is_dynamic_creative: false, targeting: {} }] }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [meta] = await adapter.getAdSetMeta("meta_camp_1");

    expect(meta.status).toBe("active");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("effective_status");
  });

  it("getAdSetMeta requests the ads sub-field and treats a genuinely-omitted `ads` field as zero ads (AIC-65)", async () => {
    // Real GelNails shape, captured live: Meta OMITS `ads` entirely for an ad
    // set with no ads (not {data: []}) — this query always requests the
    // field, so an omission here must be treated as confirmed-zero, not
    // "unknown, don't penalize" (that default protects OTHER callers that
    // never asked for the field at all).
    const mock = vi.fn(async (_url: string) => ({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { id: "as_real", name: "Real", effective_status: "ACTIVE", is_dynamic_creative: false, targeting: {}, ads: { data: [{ id: "ad_1" }] } },
          { id: "as_dead", name: "Dead draft", effective_status: "ACTIVE", is_dynamic_creative: false, targeting: {} }, // no `ads` key at all
        ],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const meta = await adapter.getAdSetMeta("meta_camp_1");

    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("ads.limit(1){id}");
    expect(meta.find((m) => m.adSetId === "as_real")?.isManaged).toBe(true);
    expect(meta.find((m) => m.adSetId === "as_dead")?.isManaged).toBe(false);
  });
});

describe("GraphCampaignAdapter getDeliveryHealth — deliveringAdCount (AIC-71)", () => {
  // Real GelNails shape: the ad set is ACTIVE and healthy (no issues_info), but
  // the customer paused its only ad via the manual controls (AIC-66). The ad
  // set's OWN status never reflects that — only counting each ad's real status
  // catches it.
  it("an ACTIVE, issue-free ad set with its only ad PAUSED counts zero delivering ads", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        String(url).includes("/adsets?")
          ? { data: [{ id: "as_1", name: "Set A", effective_status: "ACTIVE" }] }
          : { data: [{ id: "ad_1", adset_id: "as_1", effective_status: "PAUSED" }] },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [health] = await adapter.getDeliveryHealth("meta_camp_1");

    expect(health.state).toBe("delivering"); // ad set itself is healthy
    expect(health.deliveringAdCount).toBe(0); // but nothing under it is showing
  });

  it("counts only the ads that are themselves delivering, across multiple ads", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        String(url).includes("/adsets?")
          ? { data: [{ id: "as_1", name: "Set A", effective_status: "ACTIVE" }] }
          : {
              data: [
                { id: "ad_1", adset_id: "as_1", effective_status: "ACTIVE" },
                { id: "ad_2", adset_id: "as_1", effective_status: "PAUSED" },
                { id: "ad_3", adset_id: "as_1", effective_status: "ACTIVE" },
              ],
            },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [health] = await adapter.getDeliveryHealth("meta_camp_1");

    expect(health.deliveringAdCount).toBe(2);
  });

  it("an errored ad still gets counted toward the rollup check without inflating deliveringAdCount", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () =>
        String(url).includes("/adsets?")
          ? { data: [{ id: "as_1", name: "Set A", effective_status: "ACTIVE" }] }
          : { data: [{ id: "ad_1", adset_id: "as_1", effective_status: "ACTIVE", issues_info: [{ error_message: "Creative rejected" }] }] },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [health] = await adapter.getDeliveryHealth("meta_camp_1");

    expect(health.state).toBe("not_delivering"); // existing AIC-39 rollup, unaffected
    expect(health.deliveringAdCount).toBe(0);
  });
});

describe("GraphCampaignAdapter getCampaignState — status vs effective_status (AIC-70)", () => {
  // Real bug, 2026-08-12: a customer clicked "resume ad", the write succeeded
  // and was read-back verified, but the UI's next read of THIS method still
  // showed it paused — because effective_status lags the write while `status`
  // (what was just set) does not. commit 556cbcb fixed the three read-back
  // verifiers (getCampaignStatus/getAdSetStatus/getAdStatus) to read `status`;
  // this method was the missed fourth consumer.
  it("reports the object's own status (intent), not the lagging effective_status", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => {
        const u = String(url);
        if (u.includes("/adsets?")) {
          // status is already ACTIVE (just resumed); effective_status hasn't
          // caught up yet and still reports PAUSED.
          return { data: [{ id: "as_1", daily_budget: null, status: "ACTIVE", effective_status: "PAUSED" }] };
        }
        if (u.includes("/ads?")) {
          return { data: [{ id: "ad_1", status: "PAUSED", effective_status: "ACTIVE" }] };
        }
        return { daily_budget: "3000", status: "ACTIVE", effective_status: "ACTIVE", name: "Camp" };
      },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const state = await adapter.getCampaignState("meta_camp_1");

    expect(state.adSetStatuses.as_1).toBe("active"); // trusts status, not the stale effective_status
    expect(state.adStatuses.ad_1).toBe("paused");
  });

  // AIC-100: campaignStatus joins adStatuses/adSetStatuses, read from the
  // campaign's own `status` (same intent-vs-effective reasoning above) so
  // the customer app can resolve an ad's real delivery from all three
  // own-intents instead of a single ambiguous field.
  it("also reports the campaign's own status (campaignStatus)", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => {
        const u = String(url);
        if (u.includes("/adsets?")) return { data: [{ id: "as_1", daily_budget: null, status: "ACTIVE" }] };
        if (u.includes("/ads?")) return { data: [{ id: "ad_1", status: "ACTIVE" }] };
        // campaign itself is paused, even though everything under it reads active
        return { daily_budget: "3000", status: "PAUSED", effective_status: "PAUSED", name: "Camp" };
      },
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const state = await adapter.getCampaignState("meta_camp_1");

    expect(state.campaignStatus).toBe("paused");
    expect(state.adStatuses.ad_1).toBe("active");
    expect(state.adSetStatuses.as_1).toBe("active");
  });
});

describe("GraphCampaignAdapter getLifetimeLeads (AIC-67 follow-up)", () => {
  // REGRESSION (real bug, live): summing insight_snapshots' overlapping
  // rolling-7-day windows counted the same real lead multiple times. The fix
  // is a single date_preset=maximum call — this pins that the request never
  // reconstructs a range from stored periods, and that leads are extracted
  // the same way (7d-attribution action type preferred) as everywhere else.
  it("requests date_preset=maximum at campaign level, extracts leads via the shared priority list", async () => {
    const mock = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => ({
        data: [{
          actions: [
            { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" },
            { action_type: "link_click", value: "22" },
          ],
        }],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const leads = await adapter.getLifetimeLeads("meta_camp_1");

    expect(leads).toBe(4);
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("level=campaign");
    expect(url).toContain("date_preset=maximum");
  });

  it("no actions at all → zero, not an error", async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{}] }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.getLifetimeLeads("meta_camp_1")).toBe(0);
  });

  // AIC-87: getLifetimeTotals is the second independent lead-definition site
  // (besides ingestion) — a Pixel campaign's real conversions must count here too.
  it("getLifetimeTotals honors a per-campaign lead-event list (AIC-87)", async () => {
    const mock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: [{
          spend: "205.06",
          actions: [
            { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "26" },
            { action_type: "link_click", value: "156" },
          ],
        }],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const r = await adapter.getLifetimeTotals("meta_pixel_1", ["offsite_conversion.fb_pixel_complete_registration"]);

    expect(r.leads).toBe(26);
    expect(r.spendAgorot).toBe(20506);
  });
});

// AIC-88: the real ad-set shape, captured live before this module was written.
describe("GraphCampaignAdapter getAdSetTracking (AIC-88)", () => {
  it("maps the real Pixel ad-set shape (free_beta_signups_leads)", async () => {
    const mock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: [{
          id: "120248238539100352",
          name: "18-28_university-admission,student_website",
          optimization_goal: "OFFSITE_CONVERSIONS",
          destination_type: "UNDEFINED",
          promoted_object: { pixel_id: "984664453249037", custom_event_type: "COMPLETE_REGISTRATION", smart_pse_enabled: false },
        }],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [cfg] = await adapter.getAdSetTracking("meta_camp_1");

    expect(cfg).toEqual({
      adSetId: "120248238539100352",
      name: "18-28_university-admission,student_website",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      destinationType: "UNDEFINED",
      pixelId: "984664453249037",
      customEventType: "COMPLETE_REGISTRATION",
    });
  });

  it("maps the real Click-to-WhatsApp ad-set shape (GelNails) — no promoted_object.pixel_id", async () => {
    const mock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: [{
          id: "120249004871300352",
          name: "GelNails audience",
          optimization_goal: "CONVERSATIONS",
          destination_type: "WHATSAPP",
          promoted_object: { page_id: "100457729476059", smart_pse_enabled: false },
        }],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const [cfg] = await adapter.getAdSetTracking("meta_camp_1");

    expect(cfg.pixelId).toBeNull();
    expect(cfg.customEventType).toBeNull();
    expect(cfg.optimizationGoal).toBe("CONVERSATIONS");
  });

  it("no ad sets at all → empty array, not an error", async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    expect(await adapter.getAdSetTracking("meta_camp_1")).toEqual([]);
  });
});

// AIC-131, found by asking "were the ads I deleted really deleted?". The
// reaper's in-use check read /ads with Meta's DEFAULT filtering, which excludes
// ARCHIVED ads — while the comment above it claimed the opposite. Measured on a
// real account: 8 ads by default, 18 with ARCHIVED requested. Every one of those
// ten archived ads' creatives would have read as orphaned and been deleted out
// from under them.
describe("listAdCreativeIdsInUse — archived ads must be visible (AIC-131)", () => {
  it("asks Meta for ARCHIVED explicitly, because the default hides them", async () => {
    let requested = "";
    const fetchMock = vi.fn(async (url: string) => {
      requested = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ creative: { id: "cr_1" } }, { creative: { id: "cr_2" } }] }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const ids = await new GraphCampaignAdapter("T").listAdCreativeIdsInUse("act_1");

    expect(ids).toEqual(["cr_1", "cr_2"]);
    expect(decodeURIComponent(requested)).toContain("ARCHIVED");
    // The statuses a live ad can sit in, each of which still holds its creative.
    for (const st of ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "DISAPPROVED", "PENDING_REVIEW"]) {
      expect(decodeURIComponent(requested)).toContain(st);
    }
    // DELETED is deliberately absent: Meta refuses the request outright
    // (subcode 1815001), so including it would break the whole read and leave
    // the reaper unable to check anything.
    expect(decodeURIComponent(requested)).not.toContain('"DELETED"');
  });
});
