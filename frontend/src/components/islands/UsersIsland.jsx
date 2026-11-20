import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, IconButton, Input, Select, Switch, DeleteConfirm, Toast } from "../../ds";
import { api } from "../../lib/api.js";
import { ROLE_WORDS, roleCan, roleLabel } from "../shell/roles.js";

const ROLES = ["admin", "editor", "viewer"].map((r) => ({ value: r, label: roleLabel(r) }));
const ROLE_TONES = { admin: "accent", editor: "ok", viewer: "neutral" };
const NO_ROLE = "No role yet, so this person sees nothing until you give them one.";
const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username;

const TH = {
  fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const COLS = "1fr 1fr 90px 90px 40px";
// Under 560px the email sits under the name and status under the role, so
// every column stays on screen.
const NARROW_COLS = "minmax(0,1fr) auto 40px";
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
  const [toast, setToast] = React.useState(null);
  // The table's own width, measured after mount (the island is server-rendered).
  const [tableEl, setTableEl] = React.useState(null);
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    if (!tableEl) return undefined;
    const observer = new ResizeObserver(() => setNarrow(tableEl.offsetWidth < 560));
    observer.observe(tableEl);
    return () => observer.disconnect();
  }, [tableEl]);

  React.useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

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
      role: u.role ?? "", // no role stays no role until the admin picks one
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
        await load();
        setDialog(null);
        setToast({
          title: `Created ${draft.username.trim()} as ${roleLabel(draft.role)}`,
          detail: draft.temporary ? "They choose their own password the first time they sign in." : undefined,
        });
      } else {
        const body = {
          email: draft.email.trim() || null,
          first_name: draft.firstName.trim() || null,
          last_name: draft.lastName.trim() || null,
          role: draft.role || null,
          enabled: draft.enabled,
        };
        const changes = [
          body.role !== (editing.role ?? null) && `role now ${roleLabel(body.role)}`,
          body.enabled !== editing.enabled && (body.enabled ? "can sign in again" : "can't sign in now"),
          body.email !== (editing.email ?? null) && "email updated",
          (body.first_name !== (editing.first_name ?? null) || body.last_name !== (editing.last_name ?? null)) && "name updated",
        ].filter(Boolean);
        const { username } = editing;
        await api(`/users/${editing.id}`, { method: "PATCH", body });
        await load();
        setDialog(null);
        setToast({ title: `Saved ${username}`, detail: changes.length ? `${changes.join(", ")}.` : "Nothing changed." });
      }
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
      setToast({
        title: `Password set for ${editing.username}`,
        detail: newPasswordTemp ? "They choose a new one the next time they sign in." : undefined,
      });
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
      const { username } = editing;
      await api(`/users/${editing.id}`, { method: "DELETE" });
      await load();
      setDialog(null);
      setToast({ title: `Deleted ${username}` });
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
      <dl style={{ margin: 0, padding: "12px 24px 0", display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", fontSize: "var(--text-xs)", flex: "none" }}>
        {["viewer", "editor", "admin"].map((r) => (
          <React.Fragment key={r}>
            <dt style={{ fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{ROLE_WORDS[r].label}</dt>
            <dd style={{ margin: 0, color: "var(--text-secondary)" }}>{ROLE_WORDS[r].can}</dd>
          </React.Fragment>
        ))}
      </dl>
      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>
      )}
      <div style={{ flex: 1, overflowY: "auto", margin: 20, minWidth: 0 }}>
        <div ref={setTableEl} style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflowX: "auto" }}>
          <div style={{ minWidth: narrow ? 0 : 560 }}>
          <div style={{ display: "grid", gridTemplateColumns: narrow ? NARROW_COLS : COLS, gap: narrow ? 8 : 0, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...TH }}>
            {narrow
              ? <><span>User</span><span>Role</span><span /></>
              : <><span>User</span><span>Email</span><span>Role</span><span>Status</span><span /></>}
          </div>
          {users.map((u, i) => {
            const email = <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email || "—"}</span>;
            const role = <span title={u.role ? roleCan(u.role) : NO_ROLE}>{u.role ? <Badge tone={ROLE_TONES[u.role]}>{roleLabel(u.role)}</Badge> : <Badge tone="warn">no role</Badge>}</span>;
            const status = (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: u.enabled ? "var(--ok-fg)" : "var(--text-secondary)" }}>
                {u.enabled ? "enabled" : "disabled"}
              </span>
            );
            // A click anywhere on the row edits; keyboard and screen readers
            // use the row's one button, so no control sits inside another.
            return (
            <div key={u.id} onClick={() => openEdit(u)}
              style={{ display: "grid", gridTemplateColumns: narrow ? NARROW_COLS : COLS, alignItems: "center", padding: "10px 16px", gap: 8,
                borderBottom: i < users.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)" }}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {displayName(u)}
                </span>
                {u.username !== u.email && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.username}
                  </span>
                )}
                {narrow && email}
              </span>
              {narrow
                ? <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>{role}{status}</span>
                : <>{email}{role}{status}</>}
              <IconButton size="sm" label={`Edit ${displayName(u)}`} onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                <Icon name="pencil" size={13} />
              </IconButton>
            </div>
            );
          })}
          {users.length === 0 && !error && (
            <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>No users yet. Add one with New user above.</div>
          )}
          </div>
        </div>
      </div>

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New user" : `Edit ${editing?.username ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)} onConfirm={remove} disabled={saving}
                label="Delete" confirmLabel={"Delete user"} style={{ marginRight: "auto" }} />
            )}
            {/* While a delete is armed, Keep is the one way back. */}
            {!confirmingDelete && <>
              <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
              <Button size="sm" variant="accent" disabled={saving} onClick={save}>
                {dialog?.mode === "new" ? "Create user" : "Save"}
              </Button>
            </>}
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Select label="Role" value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              options={draft.role ? ROLES : [{ value: "", label: "No role", disabled: true }, ...ROLES]} />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{draft.role ? roleCan(draft.role) : NO_ROLE}</span>
          </div>

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
      {toast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 200, maxWidth: "calc(100vw - 40px)" }}>
          <Toast tone="ok" title={toast.title} detail={toast.detail} onDismiss={() => setToast(null)} style={{ width: "auto", maxWidth: 340 }} />
        </div>
      )}
    </>
  );
}
