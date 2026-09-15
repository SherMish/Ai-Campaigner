import { describe, it, expect } from "vitest";
import { tokenForPath } from "./api";

// AIC-189 — which credential each request carries while an admin is viewing a
// customer. The bug this guards: the viewing token used to REPLACE the admin's
// session, so the admin console broke in every tab and exiting logged the admin
// out.
const all = { admin: "", auth: "ADMIN-SESSION", impersonation: "VIEWING-MOSHE" };

describe("tokenForPath", () => {
  it("never sends a viewing token to the admin API", () => {
    // The server refuses it there; sending it would turn the console into a 403.
    expect(tokenForPath("/admin/users", all)).toBe("ADMIN-SESSION");
  });

  it("sends the viewing token for the customer's reads", () => {
    expect(tokenForPath("/app/overview", all)).toBe("VIEWING-MOSHE");
    expect(tokenForPath("/app/audiences?range=week", all)).toBe("VIEWING-MOSHE");
  });

  it("sends the viewing token for customer WRITES too, so the server can refuse them", () => {
    // Sending the admin's own session instead would act on the ADMIN's account.
    expect(tokenForPath("/app/business-details", all)).toBe("VIEWING-MOSHE");
    expect(tokenForPath("/meta/oauth/start", all)).toBe("VIEWING-MOSHE");
  });

  it("keeps /auth/me on the signed-in session, so the admin gate still recognises the admin", () => {
    expect(tokenForPath("/auth/me", all)).toBe("ADMIN-SESSION");
  });

  it("behaves exactly as before when nobody is viewing", () => {
    const plain = { admin: "", auth: "CUSTOMER", impersonation: "" };
    expect(tokenForPath("/app/overview", plain)).toBe("CUSTOMER");
    expect(tokenForPath("/admin/users", plain)).toBe("CUSTOMER");
  });

  it("prefers a break-glass admin token for /admin", () => {
    expect(tokenForPath("/admin/users", { admin: "BREAK-GLASS", auth: "X", impersonation: "Y" })).toBe("BREAK-GLASS");
  });
});
