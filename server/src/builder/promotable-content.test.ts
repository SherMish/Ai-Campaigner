import { describe, it, expect, vi } from "vitest";
import { listPromotableContent } from "./promotable-content.js";
import type { PromotablePost } from "./creative-types.js";

const fb = (id: string, at: string): PromotablePost => ({ id, message: `fb ${id}`, pictureUrl: null, createdAt: at, source: "facebook" });
const ig = (id: string, at: string): PromotablePost => ({ id, message: `ig ${id}`, pictureUrl: null, createdAt: at, source: "instagram", boostable: true });

function reader(posts: PromotablePost[], media: PromotablePost[] | Error) {
  return {
    listPromotablePosts: async () => posts,
    listInstagramMedia: async () => { if (media instanceof Error) throw media; return media; },
  };
}

describe("listPromotableContent (AIC-156)", () => {
  it("merges both networks, newest first", () => {
    // The customer is looking for "the post from last week" — they do not
    // think of it as a Facebook post or an Instagram post first.
    return listPromotableContent(
      reader([fb("f1", "2026-08-01T00:00:00Z"), fb("f2", "2026-08-20T00:00:00Z")],
             [ig("i1", "2026-08-10T00:00:00Z"), ig("i2", "2026-08-25T00:00:00Z")]),
      "page_1", "ig_1",
    ).then((r) => {
      expect(r.map((p) => p.id)).toEqual(["i2", "f2", "i1", "f1"]);
    });
  });

  it("returns Facebook only when the customer has no Instagram", async () => {
    // Not an error — plenty of customers have no IG account at all.
    const r = await listPromotableContent(reader([fb("f1", "2026-08-01T00:00:00Z")], []), "page_1", null);
    expect(r.map((p) => p.id)).toEqual(["f1"]);
  });

  it("a failing Instagram read must NOT cost the Facebook posts", async () => {
    // The IG half is the fragile one: it needs instagram_basic, which the
    // System User token only gained on 2026-08-31, and an account still linked
    // to the Page. If that ever breaks, a customer must not lose the ability
    // to promote a Facebook post they have had for months.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await listPromotableContent(
      reader([fb("f1", "2026-08-01T00:00:00Z")], new Error("(#10) requires instagram_basic")),
      "page_1", "ig_1",
    );
    expect(r.map((p) => p.id)).toEqual(["f1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a missing timestamp sorts last instead of scrambling the order", async () => {
    const r = await listPromotableContent(
      reader([fb("f1", ""), fb("f2", "2026-08-20T00:00:00Z")], [ig("i1", "2026-08-25T00:00:00Z")]),
      "page_1", "ig_1",
    );
    expect(r.map((p) => p.id)).toEqual(["i1", "f2", "f1"]);
  });
});
