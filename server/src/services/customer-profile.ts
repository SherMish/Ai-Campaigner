import type pg from "pg";

// AIC-138: the business profile, read and written by the CUSTOMER themselves
// from /app/settings. The same facts the ops console collects — they are the
// customer's own answers about their own business, and they are the ones best
// placed to keep them current.
//
// A SEPARATE WRITE PATH FROM updateCustomer, DELIBERATELY, and this is the
// whole security design of the file.
//
// The admin writer also accepts `isTest`, `onboardingStatus`,
// `agreedBudgetAgorot` and per-account rule-threshold overrides. Reusing it
// behind a customer route — even with the UI not showing those fields — would
// mean a customer could POST `isTest: true` and remove themselves from every
// billing and growth figure, or POST threshold overrides and change the rules
// the engine applies to their own account. The UI is not a security boundary;
// this whitelist is.
//
// So the columns are enumerated here, in one place, and nothing else is
// reachable. Adding a customer-editable field means adding it here on purpose.
const EDITABLE = [
  "business_name", "category", "main_service", "geo_area", "primary_customer",
  "offer", "differentiators", "objections", "price_range", "copy_constraints",
  "lead_followup", "contact_name", "contact_phone", "contact_email",
] as const;

type Column = (typeof EDITABLE)[number];

// camelCase in, snake_case out. Anything not in this map cannot be written.
const FIELD_TO_COLUMN: Record<string, Column> = {
  businessName: "business_name",
  category: "category",
  mainService: "main_service",
  geoArea: "geo_area",
  primaryCustomer: "primary_customer",
  offer: "offer",
  differentiators: "differentiators",
  objections: "objections",
  priceRange: "price_range",
  copyConstraints: "copy_constraints",
  leadFollowup: "lead_followup",
  contactName: "contact_name",
  contactPhone: "contact_phone",
  contactEmail: "contact_email",
};

export interface CustomerProfile {
  businessName: string;
  category: string;
  mainService: string;
  geoArea: string;
  primaryCustomer: string;
  offer: string;
  differentiators: string;
  objections: string;
  priceRange: string;
  copyConstraints: string;
  leadFollowup: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

const PROFILE_COLUMNS = `c.business_name, c.category, c.main_service, c.geo_area, c.primary_customer,
            c.offer, c.differentiators, c.objections, c.price_range, c.copy_constraints,
            c.lead_followup, c.contact_name, c.contact_phone, c.contact_email`;

// Every absent value becomes "", never null — the profile is read by form
// inputs and by the AIC-132 quality rules, and both want a string.
function mapProfileRow(r: Record<string, string | null>): CustomerProfile {
  return {
    businessName: r.business_name ?? "",
    category: r.category ?? "",
    mainService: r.main_service ?? "",
    geoArea: r.geo_area ?? "",
    primaryCustomer: r.primary_customer ?? "",
    offer: r.offer ?? "",
    differentiators: r.differentiators ?? "",
    objections: r.objections ?? "",
    priceRange: r.price_range ?? "",
    copyConstraints: r.copy_constraints ?? "",
    leadFollowup: r.lead_followup ?? "",
    contactName: r.contact_name ?? "",
    contactPhone: r.contact_phone ?? "",
    contactEmail: r.contact_email ?? "",
  };
}

/** The caller's OWN profile, resolved from their user id — never from a body. */
export async function getCustomerProfile(pool: pg.Pool, userId: string): Promise<CustomerProfile | null> {
  const { rows } = await pool.query<Record<string, string | null>>(
    `SELECT ${PROFILE_COLUMNS}
       FROM app_users u JOIN customers c ON c.id = u.customer_id
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ? mapProfileRow(rows[0]) : null;
}

/**
 * By customer id, for callers that have ALREADY resolved ownership — the
 * additions routes resolve the acting customer from the JWT before they get
 * here. Never reachable with an id from a request body; that is what the
 * user-scoped loader above is for.
 */
export async function getCustomerProfileById(pool: pg.Pool, customerId: string): Promise<CustomerProfile | null> {
  const { rows } = await pool.query<Record<string, string | null>>(
    `SELECT ${PROFILE_COLUMNS} FROM customers c WHERE c.id = $1`,
    [customerId],
  );
  return rows[0] ? mapProfileRow(rows[0]) : null;
}

export type SaveResult = "saved" | "no_customer" | "invalid";

/**
 * Update the caller's own profile.
 *
 * The customer id comes from the JOIN on the caller's user row, so a body can
 * never redirect the write at somebody else's business. Unknown keys are
 * ignored rather than rejected: a newer client sending a field this server
 * doesn't know yet should still save the rest, and silently dropping it is
 * safer than writing it.
 */
export async function saveCustomerProfile(
  pool: pg.Pool,
  userId: string,
  body: Record<string, unknown>,
): Promise<SaveResult> {
  const sets: string[] = [];
  const values: unknown[] = [userId];

  for (const [key, column] of Object.entries(FIELD_TO_COLUMN)) {
    const v = body[key];
    if (typeof v !== "string") continue;
    // Length-capped so a single field cannot be used to write megabytes into
    // the row; the express json limit bounds one request, not one column.
    values.push(v.trim().slice(0, 2000));
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return "invalid";

  // A business name is how this customer appears everywhere in the product,
  // including the ops console; blanking it would leave an unidentifiable row.
  if (typeof body.businessName === "string" && !body.businessName.trim()) return "invalid";

  const { rowCount } = await pool.query(
    `UPDATE customers SET ${sets.join(", ")}
      WHERE id = (SELECT customer_id FROM app_users WHERE id = $1)`,
    values,
  );
  return rowCount === 0 ? "no_customer" : "saved";
}
