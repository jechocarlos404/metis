import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, DeleteConfirm, Dialog, Icon, Input, Select } from "../../ds";
import { MaturityBadge } from "../shared/coverage.jsx";
import { Term } from "../shared/Term.jsx";
import { api } from "../../lib/api.js";
import { FIT, MATURITY, count, plain, statusLabel } from "../../lib/words.js";
import { FIT_TONE, STANCE_TONE } from "../../lib/ontology.js";

/**
 * `/capabilities/[slug]`: one page per capability. What it is, who uses it,
 * why it exists, build or buy (only once technology data exists), and what
 * depends on it (loaded on demand).
 */

const SECTION = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const H2 = { fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", margin: 0 };
const SUBHEAD = { fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-secondary)" };
const NOTE = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
const STATUS_TONE = { done: "ok", in_progress: "accent" };

function subtreeIds(id, all, out = new Set()) {
  out.add(id);
  for (const c of all) if (c.parent_id === id && !out.has(c.id)) subtreeIds(c.id, all, out);
  return out;
}

function treeOptions(all, excluded) {
  const out = [];
  const walk = (parentId, depth) => {
    for (const c of all.filter((x) => (x.parent_id ?? null) === parentId).sort((a, b) => a.seq - b.seq)) {
      if (excluded.has(c.id)) continue;
      out.push({ value: c.id, label: `${"   ".repeat(depth)}${c.name}` });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function CapabilityIsland({ slug, canWrite = false }) {
  const [inventory, setInventory] = React.useState(null);
  const [supply, setSupply] = React.useState(null);
  const [goals, setGoals] = React.useState([]);
  const [motivations, setMotivations] = React.useState(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [dialogError, setDialogError] = React.useState(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [removing, setRemoving] = React.useState(null); // goal id armed for unlink
  const [impact, setImpact] = React.useState(null); // null | "loading" | "error" | {dependents, dependencies}

  const all = inventory ?? [];
  const cap = all.find((c) => c.slug === slug) ?? null;

  const load = React.useCallback(async () => {
    try {
      const [inv, sup, goalList] = await Promise.all([
        api("/capabilities/inventory"),
        api(`/capabilities/${slug}/supply`),
        api("/goals"),
      ]);
      setInventory(inv);
      setSupply(sup);
      setGoals(goalList);
      const entry = inv.find((c) => c.slug === slug);
      if (entry) setMotivations(await api(`/capabilities/${entry.id}/motivations`));
    } catch (e) {
      if (e.status === 404) setNotFound(true);
      else setError(String(e.message));
    }
  }, [slug]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (notFound || (inventory && !cap)) {
    return (
      <div style={{ padding: 24, ...NOTE }}>
        No capability called "{slug}". <a href="/capabilities">See all capabilities</a>
      </div>
    );
  }
  if (error && !cap) return <div style={{ padding: 24, color: "var(--danger-fg)" }}>{error}</div>;
  if (!cap || !supply) {
    return <div role="status" style={{ padding: 24, ...NOTE }}>Loading {slug}…</div>;
  }

  const parent = all.find((c) => c.id === cap.parent_id) ?? null;
  const children = all.filter((c) => c.parent_id === cap.id).sort((a, b) => a.seq - b.seq);
  const slugByName = new Map(all.map((c) => [c.name, c.slug]));
  const facets = Object.entries(cap.facets ?? {});

  const realizations = supply.realizations ?? [];
  const groups = (products, external) => {
    const rows = realizations.filter((r) => r.external === external);
    const out = products.map((p) => ({ product: p, features: rows.filter((r) => r.product === p.slug) }));
    const loose = rows.filter((r) => !r.product);
    if (loose.length) out.push({ product: null, features: loose });
    return out.filter((g) => g.features.length > 0 || g.product);
  };
  const ours = groups(cap.products, false);
  const theirs = groups(cap.external_products, true);

  const offers = supply.answer ?? [];
  const blockedBy = (supply.unresolved ?? []).flatMap((u) => u.blocked_by ?? []);
  const showSupply = offers.length > 0 || blockedBy.length > 0;

  const linked = new Set((motivations ?? []).map((g) => g.id));
  const addable = goals.filter((g) => !linked.has(g.id));

  const openEdit = () => {
    setDraft({ name: cap.name, description: cap.description ?? "", parentId: cap.parent_id ?? "", maturity: cap.maturity });
    setDialogError(null);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setDialogError(null);
    try {
      await api(`/capabilities/${cap.id}`, {
        method: "PATCH",
        body: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          parent_id: draft.parentId || null,
          maturity: draft.maturity,
        },
      });
      setDialogOpen(false);
      await load();
    } catch (e) {
      setDialogError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/capabilities/${cap.id}`, { method: "DELETE" });
      window.location.href = "/capabilities";
    } catch (e) {
      setError(e.status === 409
        ? "Features or technologies still use this capability. Unlink them first, then delete it."
        : String(e.message));
      setConfirmingDelete(false);
      setSaving(false);
    }
  };

  const addMotivation = async (goalId) => {
    setError(null);
    try {
      await api(`/capabilities/${cap.id}/motivations`, { method: "POST", body: { goal_id: goalId } });
      setMotivations(await api(`/capabilities/${cap.id}/motivations`));
    } catch (e) {
      setError(String(e.message));
    }
  };

  const removeMotivation = async (goalId) => {
    setError(null);
    try {
      await api(`/capabilities/${cap.id}/motivations/${goalId}`, { method: "DELETE" });
      setRemoving(null);
      setMotivations(await api(`/capabilities/${cap.id}/motivations`));
    } catch (e) {
      setError(String(e.message));
    }
  };

  const loadImpact = async (open) => {
    if (!open || (impact && impact !== "error")) return;
    setImpact("loading");
    try {
      setImpact(await api(`/capabilities/${cap.id}/impact`));
    } catch {
      setImpact("error");
    }
  };

  const excluded = subtreeIds(cap.id, all);
  const parentOptions = [{ value: "", label: "None (top level)" }, ...treeOptions(all, excluded)];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title={cap.name}
        meta={<MaturityBadge maturity={cap.maturity} />}
        actions={
          canWrite && (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={openEdit}>
                <Icon name="pencil" size={13} />Edit
              </Button>
              {confirmingDelete && children.length > 0 && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  {children.length === 1
                    ? "Its sub-capability will move to the top level."
                    : `Its ${children.length} sub-capabilities will move to the top level.`}
                </span>
              )}
              <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)}
                onConfirm={remove} disabled={saving} label="Delete" confirmLabel="Delete capability" />
            </span>
          )
        }
      />

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
        {error && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}

        <section style={SECTION}>
          <h2 style={H2}>What it is</h2>
          {cap.description ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", maxWidth: "68ch", textWrap: "pretty" }}>{cap.description}</div>
          ) : (
            <div style={NOTE}>{canWrite ? "No description yet. Add one with Edit." : "No description yet."}</div>
          )}
          {parent && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
              Part of <a href={`/capabilities/${parent.slug}`}>{parent.name}</a>
            </div>
          )}
          {facets.length > 0 && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              {facets.map(([k, v]) => <span key={k}>{k}: {v}</span>)}
            </div>
          )}
          {children.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={SUBHEAD}>{count(children.length, "sub-capability", "sub-capabilities")}</div>
              {children.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--text-sm)" }}>
                  <a href={`/capabilities/${c.slug}`}>{c.name}</a>
                  <MaturityBadge maturity={c.maturity} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={SECTION}>
          <h2 style={H2}>Who uses it</h2>
          {ours.length === 0 ? (
            <div style={NOTE}>
              None of our products uses it yet.{" "}
              {canWrite ? <>Link a feature to it on <a href="/features">Features</a>.</> : "An editor or admin can link features to it."}
            </div>
          ) : (
            ours.map((g) => <ProductGroup key={g.product?.id ?? "none"} group={g} slugByName={slugByName} external={false} />)
          )}
          {theirs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border-hairline)", paddingTop: 10 }}>
              <div style={SUBHEAD}>Also in products we don't own (not counted)</div>
              {theirs.map((g) => <ProductGroup key={g.product?.id ?? "none"} group={g} slugByName={slugByName} external />)}
            </div>
          )}
        </section>

        <section style={SECTION}>
          <h2 style={H2}>Why</h2>
          {motivations == null ? (
            <div style={NOTE}>Loading goals…</div>
          ) : motivations.length === 0 ? (
            <div style={NOTE}>
              No goal explains it yet.{" "}
              {canWrite ? (addable.length ? "Link one below." : <>Create one on <a href="/goals">Goals</a>.</>) : "An editor or admin can link one."}
            </div>
          ) : (
            motivations.map((g) => (
              <div key={g.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: "var(--text-sm)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{g.display_id}</span>
                <a href={`/goals?goal=${g.id}`} style={{ flex: 1, minWidth: 0 }}>{g.title}</a>
                {canWrite && (
                  <DeleteConfirm armed={removing === g.id} onArm={() => setRemoving(g.id)} onCancel={() => setRemoving(null)}
                    onConfirm={() => removeMotivation(g.id)} label="Unlink" confirmLabel="Unlink goal" />
                )}
              </div>
            ))
          )}
          {canWrite && addable.length > 0 && (
            <div style={{ maxWidth: 420 }}>
              <Select aria-label="Link a goal" value="" onChange={(e) => e.target.value && addMotivation(e.target.value)}
                options={[{ value: "", label: "Link a goal…" }, ...addable.map((g) => ({ value: g.id, label: `${g.display_id} ${g.title}` }))]} />
            </div>
          )}
        </section>

        {showSupply && (
          <section style={SECTION}>
            <h2 style={H2}>Build or buy</h2>
            {offers.length === 0 ? (
              <div style={NOTE}>Every technology that could do this is ruled out by {blockedBy.join(", ")}.</div>
            ) : (
              offers.map((o) => (
                <div key={o.tech} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: "var(--text-sm)" }}>
                  <a href={`/tech/${o.tech}`} style={{ flex: "1 1 160px", minWidth: 0 }}>{o.tech}</a>
                  <Badge tone={FIT_TONE[o.fit] ?? "neutral"}><Term dict={FIT} value={o.fit} /></Badge>
                  <Badge tone={o.stance ? STANCE_TONE[o.stance] ?? "neutral" : "neutral"}>{o.stance ? plain({}, o.stance) : "no stance"}</Badge>
                  {typeof o.cost?.ops_burden === "number" && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>upkeep {o.cost.ops_burden} of 3</span>
                  )}
                  {o.bound_in.length > 0 && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>
                      in use in {o.bound_in.map((b) => b.split("::")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                    </span>
                  )}
                </div>
              ))
            )}
          </section>
        )}

        <details style={{ ...SECTION, display: "block" }} onToggle={(e) => loadImpact(e.currentTarget.open)}>
          <summary style={{ ...H2, cursor: "pointer" }}>What depends on it</summary>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {impact === "loading" || impact == null ? (
            <div style={NOTE}>Loading…</div>
          ) : impact === "error" ? (
            <div style={NOTE}>Couldn't load this right now. Close and open again to retry.</div>
          ) : impact.dependents.length === 0 && impact.dependencies.length === 0 ? (
            <div style={NOTE}>Nothing depends on it, and it needs nothing else.</div>
          ) : (
            <>
              <ImpactList title={`${count(impact.dependents.length, "capability", "capabilities")} need this`} items={impact.dependents} />
              <ImpactList title={`It needs ${count(impact.dependencies.length, "capability", "capabilities")}`} items={impact.dependencies} />
            </>
          )}
          </div>
        </details>
      </div>

      <Dialog
        open={dialogOpen}
        title={`Edit ${cap.name}`}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft?.name.trim()} onClick={save}>Save</Button>
          </>
        }
      >
        {draft && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {dialogError && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>}
            <Input label="Name" hint="A noun phrase, e.g. Route planning" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <Select label="Maturity" value={draft.maturity} onChange={(e) => setDraft({ ...draft, maturity: e.target.value })}
              options={Object.entries(MATURITY).map(([value, label]) => ({ value, label }))} />
            <Select label="Part of" value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} options={parentOptions} />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function ProductGroup({ group, slugByName, external }) {
  const { product, features } = group;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>
        {product ? <a href={`/products?product=${product.id}`}>{product.name}</a> : "No product"}
        <span style={{ marginLeft: 8, fontSize: "var(--text-xs)", fontWeight: "normal", color: "var(--text-secondary)" }}>
          {count(features.length, "feature")}
        </span>
      </div>
      {features.map((r) => (
        <div key={r.id ?? r.feature} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingLeft: 12, fontSize: "var(--text-sm)" }}>
          {r.id ? <a href={`/features?feature=${r.id}`}>{r.feature}</a> : <span>{r.feature}</span>}
          {r.via && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              through sub-capability{" "}
              {slugByName.has(r.via) ? <a href={`/capabilities/${slugByName.get(r.via)}`}>{r.via}</a> : r.via}
            </span>
          )}
          {!external && (
            <Badge tone={STATUS_TONE[r.status] ?? "neutral"}><span title={r.status}>{statusLabel(r.status)}</span></Badge>
          )}
          {r.tickets > 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{count(r.tickets, "ticket")}</span>}
        </div>
      ))}
    </div>
  );
}

function ImpactList({ title, items }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={SUBHEAD}>{title}</div>
      {items.map((c) => (
        <a key={c.id} href={`/capabilities/${c.slug}`} style={{ fontSize: "var(--text-sm)" }}>{c.name}</a>
      ))}
    </div>
  );
}
