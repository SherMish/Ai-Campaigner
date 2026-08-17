import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { strings } from "../strings";
import { offersOnboarding } from "./user-row-status";

const u = strings.he.adminUsers;
const t = strings.he.ops;
const a = strings.he.admin;

interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  customerId: string | null;
  businessName: string | null;
  subscriptionStatus: string | null;
  accessHealth: string | null;
  campaignStatus: string | null;
  connectionReadiness: "no_campaign" | "not_launched" | "missing_page" | "connection_issue" | "incomplete_config" | null;
}

// Separate from AdminCustomers (explicit product decision, 2026-08-16): a
// user is the login (email/password/name) — every real signup has a row
// here, even one that never got a business linked, which the
// customers-only view can't show. Clicking a row is the entry point into
// the AIC-101 onboarding wizard; a user with no business yet gets a bare
// one created and linked on that first click (server/src/services/
// users-admin.ts's ensureCustomerForUser), then the wizard opens on it.
export function AdminUsers() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [provisioningId, setProvisioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ users: UserRow[] }>("/admin/users")
      .then((r) => setUsers(r.users))
      .catch(() => setError(u.provisionError))
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter((row) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return row.email.toLowerCase().includes(q) || row.name.toLowerCase().includes(q);
  });

  async function handleRowClick(row: UserRow) {
    // Already fully connected — the wizard would only create a duplicate
    // connection/campaign for this customer (provisionConnection always
    // inserts, never upserts). Send the operator to the real customer
    // record instead, same jump-to pattern the Overview search uses.
    if (!offersOnboarding(row)) {
      navigate(`/admin/customers?focus=${row.customerId}`);
      return;
    }
    if (row.customerId) {
      navigate(`/admin/onboarding/${row.customerId}`);
      return;
    }
    setProvisioningId(row.id);
    setError(null);
    try {
      const r = await api<{ customerId: string }>(`/admin/users/${row.id}/customer`, { method: "POST", body: "{}" });
      navigate(`/admin/onboarding/${r.customerId}`);
    } catch {
      setError(u.provisionError);
    } finally {
      setProvisioningId(null);
    }
  }

  if (loading) return <div className="wrap page dash"><p className="muted">{a.loading}</p></div>;

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{u.title} ({filtered.length}/{users.length})</h1>

      <div className="card">
        <input
          placeholder={u.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%", font: "inherit", padding: "10px 14px", borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 14 }}
        />

        {error && <p style={{ color: "var(--orange)", fontSize: "0.85rem", marginBottom: 10 }}>{error}</p>}

        {filtered.length === 0 ? <p className="muted">{u.noResults}</p> : (
          <table className="op-table">
            <thead>
              <tr>
                <th>{u.colEmail}</th>
                <th>{u.colName}</th>
                <th>{u.colJoined}</th>
                <th>{u.colBusiness}</th>
                <th>{u.colSubscription}</th>
                <th>{u.colConnection}</th>
                <th>{u.colCampaign}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} onClick={() => handleRowClick(row)}>
                  <td>{row.email}</td>
                  <td>{row.name || a.noData}</td>
                  <td>{new Date(row.createdAt).toLocaleDateString("he-IL")}</td>
                  <td>
                    {row.businessName ?? <span className="muted">{u.noBusiness}</span>}
                    {provisioningId === row.id ? (
                      <span className="muted" style={{ marginInlineStart: 8, fontSize: "0.78rem" }}>{u.provisioning}</span>
                    ) : (
                      <span className="link" style={{ marginInlineStart: 8, fontSize: "0.82rem" }}>
                        {offersOnboarding(row) ? u.startOnboarding : u.viewCustomer}
                      </span>
                    )}
                  </td>
                  <td>{row.subscriptionStatus ?? t.none}</td>
                  <td>
                    {row.accessHealth ?? t.none}
                    {row.connectionReadiness && (
                      <span className="pill warn" style={{ marginInlineStart: 8, padding: "2px 9px", fontSize: "0.72rem" }}>
                        {t.connectionReadinessReason[row.connectionReadiness]}
                      </span>
                    )}
                  </td>
                  <td>{row.campaignStatus ?? t.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
