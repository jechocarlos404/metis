import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, IconButton, Input, Select, Switch } from "../../ds";
import { api } from "../../lib/api.js";

const ROLES = ["admin", "editor", "viewer"];
const ROLE_TONES = { admin: "accent", editor: "ok", viewer: "neutral" };

const TH = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const COLS = "1fr 1fr 90px 90px 40px";
const EMPTY = { username: "", email: "", firstName: "", lastName: "", role: "viewer", password: "", temporary: true };

export default function UsersIsland() {
  const [users, setUsers] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit", id}
  const [draft, setDraft] = React.useState(EMPTY);
  const [newPassword, setNewPassword] = React.useState("");
  const [newPasswordTemp, setNewPasswordTemp] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [dialogError, setDialogError] = React.useState(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  const editing = dialog?.mode === "edit" ? users.find((u) => u.id === dialog.id) : null;

  const load = React.useCallback(async () => {
    setUsers(await api("/users"));
  }, []);

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  const openNew = () => {
    setDraft(EMPTY);
    setDialogError(null);
    setConfirmingDelete(false);
    setDialog({ mode: "new" });
  };

  const openEdit = (u) => {
    setDraft({
      username: u.username,
      email: u.email ?? "",
      firstName: u.first_name ?? "",
      lastName: u.last_name ?? "",
      role: u.role ?? "viewer",
      enabled: u.enabled,
    });
    setNewPassword("");
    setNewPasswordTemp(true);
    setDialogError(null);
    setConfirmingDelete(false);
    setDialog({ mode: "edit", id: u.id });
  };

  const save = async () => {
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog.mode === "new") {
        if (!draft.username.trim() || !draft.password) {
          setDialogError("Username and initial password are required.");
          setSaving(false);
          return;
        }
        await api("/users", {
          method: "POST",
          body: {
            username: draft.username.trim(),
            email: draft.email.trim() || null,
            first_name: draft.firstName.trim() || null,
            last_name: draft.lastName.trim() || null,
            role: draft.role,
            password: draft.password,
            temporary: draft.temporary,
          },
        });
      } else {
        await api(`/users/${editing.id}`, {
          method: "PATCH",
          body: {
            email: draft.email.trim() || null,
            first_name: draft.firstName.trim() || null,
            last_name: draft.lastName.trim() || null,
            role: draft.role,
            enabled: draft.enabled,
          },
        });
      }
      await load();
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (!newPassword) return;
    setSaving(true);
    setDialogError(null);
    try {
      await api(`/users/${editing.id}/reset-password`, {
        method: "POST",
        body: { password: newPassword, temporary: newPasswordTemp },
      });
      setNewPassword("");
      setDialogError(null);
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setDialogError(null);
    try {
      await api(`/users/${editing.id}`, { method: "DELETE" });
      await load();
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        meta={`${users.length} user${users.length === 1 ? "" : "s"} · Keycloak-managed`}
        actions={
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
            <Icon name="plus" size={13} />New user
          </Button>
        }
      />
      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>
      )}
      <div style={{ flex: 1, overflowY: "auto", margin: 20, minWidth: 0 }}>
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: COLS, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...TH }}>
            <span>User</span><span>Email</span><span>Role</span><span>Status</span><span />
          </div>
          {users.map((u, i) => (
            <div key={u.id} onClick={() => openEdit(u)}
              style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "10px 16px", gap: 8,
                borderBottom: i < users.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)" }}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[u.first_name, u.last_name].filter(Boolean).join(" ") || u.username}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {u.username}
                </span>
              </span>
              <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email || "—"}</span>
              <span>{u.role ? <Badge tone={ROLE_TONES[u.role]}>{u.role}</Badge> : <Badge tone="warn">none</Badge>}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: u.enabled ? "var(--ok-fg)" : "var(--text-secondary)" }}>
                {u.enabled ? "enabled" : "disabled"}
              </span>
              <IconButton size="sm" label="Edit user" onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                <Icon name="pencil" size={13} />
              </IconButton>
            </div>
          ))}
          {users.length === 0 && !error && (
            <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>No users yet.</div>
          )}
        </div>
      </div>

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New user" : `Edit ${editing?.username ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <Button size="sm" variant={confirmingDelete ? "danger" : "secondary"} disabled={saving}
                style={{ marginRight: "auto", gap: 6 }}
                onClick={() => (confirmingDelete ? remove() : setConfirmingDelete(true))}>
                <Icon name="trash" size={13} />{confirmingDelete ? "Confirm delete" : "Delete"}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving} onClick={save}>
              {dialog?.mode === "new" ? "Create user" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dialogError && <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>}
          {dialog?.mode === "new" ? (
            <Input label="Username" value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="jane@metis.local" />
          ) : (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              {editing?.username}
            </div>
          )}
          <Input label="Email" type="email" value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="jane@metis.local" />
          <div style={{ display: "flex", gap: 12 }}>
            <Input label="First name" style={{ flex: 1 }} value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
            <Input label="Last name" style={{ flex: 1 }} value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
          </div>
          <Select label="Role" value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })} options={ROLES} />

          {dialog?.mode === "new" ? (
            <>
              <Input label="Initial password" type="password" value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
              <Switch label="Require password change on first login" checked={draft.temporary}
                onChange={(v) => setDraft({ ...draft, temporary: v })} />
            </>
          ) : (
            <>
              <Switch label="Enabled" checked={draft.enabled}
                onChange={(v) => setDraft({ ...draft, enabled: v })} />
              <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={TH}>Reset password</div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <Input label="New password" type="password" style={{ flex: 1 }} value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)} />
                  <Button size="md" variant="secondary" disabled={saving || !newPassword} onClick={resetPassword}>Set</Button>
                </div>
                <Switch label="Temporary (require change on next login)" checked={newPasswordTemp}
                  onChange={setNewPasswordTemp} />
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
