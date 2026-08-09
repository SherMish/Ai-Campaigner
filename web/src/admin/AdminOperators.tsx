import { useEffect, useState, useCallback } from "react";
import {
  getMe, getOperators, addOperator, setOperatorRole, removeOperator,
  getAuditLog, type OperatorRow, type FullAuditEntry,
} from "../api";
import { strings } from "../strings";

const t = strings.he.operators;
const a = strings.he.admin;

const ENTITY_TYPES = ["customer", "recommendation", "operator", "campaign"];

// Operator accounts + admin action audit log (AIC-47). Any admin can view
// both sections (transparency); only a full_admin can add/remove/promote
// operators — the one deliberate role gate in this console, enforced
// server-side (requireFullAdmin) and mirrored here for a clean UI (buttons
// disabled rather than hidden, so a non-full_admin still sees what exists).
export function AdminOperators() {
  const [isFullAdmin, setIsFullAdmin] = useState(false);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"full_admin" | "operator">("operator");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const [entries, setEntries] = useState<FullAuditEntry[]>([]);
  const [actorFilter, setActorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [auditLoading, setAuditLoading] = useState(true);

  const loadOperators = useCallback(async () => {
    const res = await getOperators();
    setOperators(res.operators);
    setLoading(false);
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    const res = await getAuditLog({ actorUserId: actorFilter || undefined, entityType: typeFilter || undefined });
    setEntries(res.entries);
    setAuditLoading(false);
  }, [actorFilter, typeFilter]);

  useEffect(() => {
    getMe().then((me) => setIsFullAdmin(me.adminRole === "full_admin"));
    loadOperators();
  }, [loadOperators]);

  useEffect(() => { loadAudit(); }, [loadAudit]);

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim()) return;
    setAddBusy(true); setAddError(null);
    try {
      await addOperator(newEmail.trim(), newRole);
      setNewEmail(""); setNewRole("operator");
      await loadOperators();
      await loadAudit();
    } catch {
      setAddError(t.addError);
    } finally {
      setAddBusy(false);
    }
  }

  async function changeRole(op: OperatorRow, role: "full_admin" | "operator") {
    setRowError(null);
    try {
      await setOperatorRole(op.id, role);
      await loadOperators();
      await loadAudit();
    } catch {
      setRowError({ id: op.id, message: t.roleChangeError });
    }
  }

  async function remove(op: OperatorRow) {
    if (!window.confirm(t.removeConfirm)) return;
    setRowError(null);
    try {
      await removeOperator(op.id);
      await loadOperators();
      await loadAudit();
    } catch {
      setRowError({ id: op.id, message: t.removeError });
    }
  }

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{t.title}</h1>
      <p className="muted">{t.subtitle}</p>

      <div className="card" style={{ marginTop: 16 }}>
        <b style={{ fontSize: "1.05rem" }}>{t.sectionOperators}</b>
        {!isFullAdmin && <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{t.onlyFullAdminNote}</p>}

        {loading ? <p className="muted">{a.loading}</p> : (
          <table className="op-table">
            <thead>
              <tr>
                <th>{t.email}</th>
                <th>{t.name}</th>
                <th>{t.role}</th>
                <th>{t.created}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {operators.map((op) => (
                <tr key={op.id} style={{ cursor: "default" }}>
                  <td>{op.email}</td>
                  <td>{op.name || a.noData}</td>
                  <td>
                    <select
                      value={op.adminRole}
                      disabled={!isFullAdmin}
                      onChange={(e) => changeRole(op, e.target.value as "full_admin" | "operator")}
                      style={{ padding: "4px 8px", borderRadius: 8, border: "1.5px solid var(--line)" }}
                    >
                      <option value="full_admin">{t.roleFullAdmin}</option>
                      <option value="operator">{t.roleOperator}</option>
                    </select>
                  </td>
                  <td>{new Date(op.createdAt).toLocaleDateString("he-IL")}</td>
                  <td>
                    <button className="btn btn-outline btn-sm" disabled={!isFullAdmin} onClick={() => remove(op)}>{t.remove}</button>
                    {rowError?.id === op.id && <div style={{ color: "var(--orange)", fontSize: "0.78rem" }}>{rowError.message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {isFullAdmin && (
          <form onSubmit={submitAdd} style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <b style={{ fontSize: "0.92rem" }}>{t.addOperator}</b>
            <p className="muted" style={{ fontSize: "0.8rem" }}>{t.addNote}</p>
            <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: "wrap" }}>
              <input
                type="email" required placeholder={t.addEmailPlaceholder} value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                style={{ flex: 1, minWidth: 220, font: "inherit", padding: "10px 14px", borderRadius: 12, border: "1.5px solid var(--line)" }}
              />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as "full_admin" | "operator")} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
                <option value="operator">{t.roleOperator}</option>
                <option value="full_admin">{t.roleFullAdmin}</option>
              </select>
              <button type="submit" className="btn btn-primary btn-sm" disabled={addBusy}>{t.add}</button>
            </div>
            {addError && <p style={{ color: "var(--orange)", fontSize: "0.85rem", marginTop: 6 }}>{addError}</p>}
          </form>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <b style={{ fontSize: "1.05rem" }}>{t.sectionAudit}</b>
        <div className="row" style={{ gap: 10, margin: "12px 0", flexWrap: "wrap" }}>
          <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
            <option value="">{t.filterActor}: {t.all}</option>
            {operators.map((op) => <option key={op.id} value={op.id}>{op.email}</option>)}
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
            <option value="">{t.filterEntityType}: {t.all}</option>
            {ENTITY_TYPES.map((et) => <option key={et} value={et}>{t.entityTypeLabels[et] ?? et}</option>)}
          </select>
        </div>

        {auditLoading ? <p className="muted">{a.loading}</p> : entries.length === 0 ? <p className="muted">{t.noEntries}</p> : (
          entries.map((e) => (
            <div key={e.id} className="op-audit-item">
              <b>{e.action}</b> — {e.entityLabel} — {e.detail}
              <div className="who">{e.actorLabel} · {new Date(e.createdAt).toLocaleString("he-IL")}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
