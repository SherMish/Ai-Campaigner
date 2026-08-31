// AIC-155 — the connected Page's name and photo for the ad preview header.
//
// Extracted so the customer builder, the admin builder and add-content cannot
// disagree about what "the Page" is. They already did: AddContent read the
// real Page while Builder read `customers.business_name`, so the same preview
// component showed a different publisher depending on which screen you opened
// it from.
//
// EVERY FAILURE IS NULLS, NEVER A THROW. A preview missing an avatar is still
// a useful preview; a step that 502s because a decorative read failed is not.
// The caller renders the neutral placeholder on nulls.
//
// `getPageIdentity` is optional on the writer for the same reason
// routes/additions.ts probes for it: the fake writer used in tests and in an
// unconfigured environment implements the create surface, not the read one.

export interface PageIdentity {
  name: string | null;
  pictureUrl: string | null;
}

const NONE: PageIdentity = { name: null, pictureUrl: null };

export async function pageIdentityOrNulls(
  writer: unknown,
  pageId: string | null | undefined,
): Promise<PageIdentity> {
  if (!pageId) return NONE;
  const reader = writer as { getPageIdentity?: (id: string) => Promise<PageIdentity> } | null;
  if (!reader?.getPageIdentity) return NONE;
  try {
    return await reader.getPageIdentity(pageId);
  } catch (e) {
    console.warn(`[builder] page identity read failed — ${(e as Error).message}`);
    return NONE;
  }
}
