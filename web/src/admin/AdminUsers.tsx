import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, deleteUserRecords, type DeleteUserMode } from "../api";
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
  // AIC-127: the delete modal. `deleteRow` doubles as "is the modal open".
  const [deleteRow, setDeleteRow] = useState<UserRow | null>(null);
  const [deleteMode, setDeleteMode] = useState<DeleteUserMode>("business");
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = () =>
    api<{ users: UserRow[] }>("/admin/users")
      .then((r) => setUsers(r.users))
      .catch(() => setError(u.provisionError))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openDelete(row: UserRow) {
    setDeleteRow(row);
    // A user with no business can only have the signup deleted — defaulting to
    // "business" would open the modal on an option the server would refuse.
    setDeleteMode(row.customerId ? "business" : "all");
    setDeleteText("");
    setDeleteError(null);
  }

  async function submitDelete() {
    if (!deleteRow) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteUserRecords(deleteRow.id, deleteMode, deleteText.trim());
      setDeleteRow(null);
      await load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : u.provisionError);
    } finally {
      setDeleteBusy(false);
    }
  }

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
                <th aria-label={u.deleteRowTitle}></th>
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
                  <td>
                    <button
                      type="button"
                      className="op-bin"
                      title={u.deleteRowTitle}
                      aria-label={`${u.deleteRowTitle} — ${row.email}`}
                      onClick={(e) => { e.stopPropagation(); openDelete(row); }}
                    >
                      {/* Inline SVG, not an emoji or an icon dependency: it
                          inherits currentColor so it can turn red on hover,
                          and it renders identically on every platform. */}
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* AIC-127: the reset/delete modal. Red-bordered and red-headed because
          it is irreversible — but the loudest thing in it is the Meta warning,
          not the styling: an operator who deletes a business and assumes the
          spend stopped is the actual danger here. */}
      {deleteRow && (
        <div className="op-modal-backdrop" onClick={() => setDeleteRow(null)}>
          <div className="op-modal op-modal-danger" onClick={(e) => e.stopPropagation()}>
            <b className="op-danger-title">{u.deleteTitle}</b>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.9rem" }}>
              {deleteRow.email}
            </p>

            <p className="op-danger-note">{u.deleteMetaWarning}</p>

            <p style={{ margin: "16px 0 8px", fontSize: "0.9rem", fontWeight: 600 }}>{u.deleteIntro}</p>

            {/* Radios, not two submit buttons: the operator picks, re-reads what
                they picked, then types the email. Two buttons would let a
                mis-aimed click delete the login when only the business was
                meant. */}
            <label className={`op-choice${deleteMode === "business" ? " active" : ""}${!deleteRow.customerId ? " disabled" : ""}`}>
              <input
                type="radio" name="delmode" value="business"
                checked={deleteMode === "business"}
                disabled={!deleteRow.customerId}
                onChange={() => setDeleteMode("business")}
              />
              <span>
                <b>{u.deleteModeBusinessTitle}</b>
                <em>{u.deleteModeBusinessBody}</em>
              </span>
            </label>
            <label className={`op-choice${deleteMode === "all" ? " active" : ""}`}>
              <input
                type="radio" name="delmode" value="all"
                checked={deleteMode === "all"}
                onChange={() => setDeleteMode("all")}
              />
              <span>
                <b>{u.deleteModeAllTitle}</b>
                <em>{u.deleteModeAllBody}</em>
              </span>
            </label>
            {!deleteRow.customerId && (
              <p className="muted" style={{ fontSize: "0.8rem", marginTop: 8 }}>{u.deleteNoBusiness}</p>
            )}

            <div className="field" style={{ marginTop: 16 }}>
              <label>{u.deleteConfirmLabel} <b dir="ltr">{deleteRow.email}</b></label>
              <input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} dir="ltr" autoFocus />
            </div>
            {deleteText.length > 0 && deleteText.trim().toLowerCase() !== deleteRow.email.toLowerCase() && (
              <p style={{ color: "#c0362c", fontSize: "0.82rem", marginTop: 6 }}>{u.deleteConfirmMismatch}</p>
            )}
            {deleteError && <p style={{ color: "#c0362c", fontSize: "0.85rem", marginTop: 8 }}>{deleteError}</p>}

            <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-sm"
                style={{ background: "#c0362c", color: "#fff" }}
                disabled={deleteBusy || deleteText.trim().toLowerCase() !== deleteRow.email.toLowerCase()}
                onClick={submitDelete}
              >
                {deleteBusy ? u.deleteBusy : deleteMode === "all" ? u.deleteSubmitAll : u.deleteSubmitBusiness}
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setDeleteRow(null)}>{u.deleteCancel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
