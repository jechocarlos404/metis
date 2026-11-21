import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, DeleteConfirm, Dialog, Icon, Input, Select, STATUS_TONE } from "../../ds";
import { MaturityBadge } from "../shared/coverage.jsx";
import { Term } from "../shared/Term.jsx";
import { Guesses } from "../shared/Guesses.jsx";
import { api } from "../../lib/api.js";
import { readParam, writeParams } from "../../lib/url-state.js";
import { FIT, MATURITY, NEED, andList, capabilityDeleteKept, capabilityDeleteLinks, count, needKey, plain, statusLabel } from "../../lib/words.js";
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

// Maturity describes our build, so only a capability that is ours shows one;
// the rest say where they stand instead ("not built yet", "only elsewhere").
function Standing({ c }) {
  if (c.ours) return <MaturityBadge maturity={c.maturity} />;
  const need = NEED[needKey(c)];
  return <span title={need.hint}><Badge tone={need.tone}>{need.label}</Badge></span>;
}

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
  const [bundles, setBundles] = React.useState([]); // every capability a product added by hand
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(null); // what the last edit changed, said in place
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [dialogError, setDialogError] = React.useState(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [guessCount, setGuessCount] = React.useState(0); // guesses a delete would drop with it
  const [detaches, setDetaches] = React.useState(null); // rows a delete keeps but leaves without it
  const [removing, setRemoving] = React.useState(null); // goal id armed for unlink
  const [impact, setImpact] = React.useState(null); // null | "loading" | "error" | {dependents, dependencies}
  const [techNames, setTechNames] = React.useState({}); // slug → name, for Build or buy

  const all = inventory ?? [];
  const cap = all.find((c) => c.slug === slug) ?? null;

  const load = React.useCallback(async () => {
    try {
      const [inv, sup, goalList, bundleList] = await Promise.all([
        api("/capabilities/inventory"),
        api(`/capabilities/${slug}/supply`),
        api("/goals"),
        api("/product-bundles"),
      ]);
      setInventory(inv);
      setSupply(sup);
      setGoals(goalList);
      setBundles(bundleList);
      const techs = await Promise.all((sup.answer ?? []).map((o) => api(`/tech/${o.tech}`).catch(() => null)));
      setTechNames(Object.fromEntries(techs.filter(Boolean).map((t) => [t.slug, t.name])));
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

  // New capability sends you here after a create; say so once.
  React.useEffect(() => {
    const name = readParam("created");
    if (name) {
      setSaved(`Created ${name}.`);
      writeParams({ created: "" });
    }
  }, []);

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
  // Products that added it by hand, with or without a feature for it (B46).
  const byHand = bundles.filter((b) => b.capability_id === cap.id).sort((a, b) => a.product_name.localeCompare(b.product_name));

  const offers = supply.answer ?? [];
  const blockedBy = (supply.unresolved ?? []).flatMap((u) => u.blocked_by ?? []);
  const showSupply = offers.length > 0 || blockedBy.length > 0;

  const linked = new Set((motivations ?? []).map((g) => g.id));
  const addable = goals.filter((g) => !linked.has(g.id));

  const openEdit = () => {
    setSaved(null);
    setDraft({ name: cap.name, description: cap.description ?? "", parentId: cap.parent_id ?? "", maturity: cap.maturity });
    setDialogError(null);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setDialogError(null);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      parent_id: draft.parentId || null,
      maturity: draft.maturity,
    };
    const newParent = all.find((c) => c.id === body.parent_id);
    const changes = [
      body.name !== cap.name && `renamed from ${cap.name}`,
      body.parent_id !== (cap.parent_id ?? null) && (newParent ? `moved under ${newParent.name}` : "moved to top level"),
      body.maturity !== cap.maturity && `maturity now ${plain(MATURITY, body.maturity)}`,
      body.description !== (cap.description ?? null) && "description updated",
    ].filter(Boolean);
    try {
      await api(`/capabilities/${cap.id}`, { method: "PATCH", body });
      setDialogOpen(false);
      setSaved(changes.length ? `Saved: ${changes.join(", ")}.` : "Saved. Nothing changed.");
      await load();
    } catch (e) {
      setDialogError(e.status === 409 && e.existing?.slug
        ? <>{e.detail}. <a href={`/capabilities/${e.existing.slug}`}>Open {e.existing.name}</a></>
        : String(e.message));
    } finally {
      setSaving(false);
    }
  };

  // What stops a delete, said before anyone confirms: features linked to this
  // capability itself (not through a sub-capability) and technologies offered for it.
  const inUse = () => {
    const features = (supply?.realizations ?? []).filter((r) => !r.via);
    const techs = supply?.answer ?? [];
    if (!features.length && !techs.length) return null;
    const named = [
      ...features.map((r) => (r.product_name ? `${r.feature} (${r.product_name})` : r.feature)),
      ...techs.map((o) => techNames[o.tech] ?? o.tech),
    ];
    const what = [
      features.length && count(features.length, "feature"),
      techs.length && count(techs.length, "technology", "technologies"),
    ].filter(Boolean).join(" and ");
    return `Can't delete: ${what} still use${features.length + techs.length === 1 ? "s" : ""} it: ${named.join(", ")}. Unlink ${features.length + techs.length === 1 ? "it" : "them"} first.`;
  };

  const armDelete = () => {
    setSaved(null);
    const blocked = inUse();
    if (blocked) setError(blocked);
    else {
      setError(null);
      setConfirmingDelete(true);
      // Read at arm, so the note names what this delete clears now.
      setDetaches(null);
      api(`/capabilities/${cap.id}/detaches`).then(setDetaches).catch(() => setDetaches(null));
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/capabilities/${cap.id}`, { method: "DELETE" });
      window.location.href = `/capabilities?deleted=${encodeURIComponent(cap.name)}`;
    } catch (e) {
      setError(e.status === 409 ? `Can't delete: ${e.message}` : String(e.message));
      setConfirmingDelete(false);
      setSaving(false);
    }
  };

  // Linking from here says what it did, as linking from the goal's side does.
  const addMotivation = async (goalId) => {
    setError(null);
    setSaved(null);
    const goal = goals.find((g) => g.id === goalId);
    try {
      await api(`/capabilities/${cap.id}/motivations`, { method: "POST", body: { goal_id: goalId } });
      setSaved(`Linked ${goal ? `${goal.display_id} ${goal.title}` : "the goal"}.`);
      setMotivations(await api(`/capabilities/${cap.id}/motivations`));
    } catch (e) {
      setError(String(e.message));
    }
  };

  const removeMotivation = async (goalId) => {
    setError(null);
    setSaved(null);
    const goal = (motivations ?? []).find((g) => g.id === goalId);
    try {
      await api(`/capabilities/${cap.id}/motivations/${goalId}`, { method: "DELETE" });
      setRemoving(null);
      setSaved(`Unlinked ${goal ? `${goal.display_id} ${goal.title}` : "the goal"}.`);
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
        meta={<Standing c={cap} />}
        actions={
          canWrite && (
            // Wraps, so an armed delete's notes take their own lines on a phone.
            <span style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, alignItems: "center", minWidth: 0 }}>
              {/* While a delete is armed, Keep is the one way back. */}
              {!confirmingDelete && (
                <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={openEdit}>
                  <Icon name="pencil" size={13} />Edit
                </Button>
              )}
              {confirmingDelete && children.length > 0 && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  {children.length === 1
                    ? "Its sub-capability will move to the top level."
                    : `Its ${children.length} sub-capabilities will move to the top level.`}
                </span>
              )}
              {/* What goes with it: the links to it that a delete removes. */}
              {confirmingDelete && capabilityDeleteLinks(motivations, guessCount) && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  {capabilityDeleteLinks(motivations, guessCount)}
                </span>
              )}
              {/* What stays but loses it: epics and stack slots that name it,
                  and products that added it by hand (B46). */}
              {confirmingDelete && capabilityDeleteKept(detaches) && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  {capabilityDeleteKept(detaches)}
                </span>
              )}
              <DeleteConfirm armed={confirmingDelete} onArm={armDelete} onCancel={() => setConfirmingDelete(false)}
                onConfirm={remove} disabled={saving} label="Delete" confirmLabel="Delete capability" />
            </span>
          )
        }
      />

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
        {error && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
        {saved && <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--ok-fg)" }}>{saved}</div>}

        <section style={SECTION}>
          <h2 style={H2} title={facets.map(([k, v]) => `${k}: ${v}`).join("\n") || undefined}>What it is</h2>
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
          {children.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={SUBHEAD}>{count(children.length, "sub-capability", "sub-capabilities")}</div>
              {children.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--text-sm)" }}>
                  <a href={`/capabilities/${c.slug}`}>{c.name}</a>
                  <Standing c={c} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={SECTION}>
          <h2 style={H2}>Who uses it</h2>
          {ours.length === 0 ? (
            <div style={NOTE}>
              {byHand.length ? "No feature of ours uses it yet." : "None of our products uses it yet."}{" "}
              {canWrite ? <>Link a feature to it on <a href="/features">Features</a>.</> : "An editor or admin can link features to it."}
            </div>
          ) : (
            <>
              {!cap.ours && <div style={NOTE}>Not built yet: our features for it are planned or in progress.</div>}
              {ours.map((g) => <ProductGroup key={g.product?.id ?? "none"} group={g} slugByName={slugByName} external={false} />)}
            </>
          )}
          {byHand.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={SUBHEAD} title="product_bundles">Added by hand (not counted)</div>
              <div style={{ fontSize: "var(--text-sm)" }}>
                {byHand.map((b, i) => (
                  <React.Fragment key={b.id}>
                    {i > 0 && ", "}
                    <a href={`/products?product=${b.product_id}`}>{b.product_name}</a>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          {canWrite && <Guesses query={{ capability_id: cap.id }} name="subject" title="Features and technologies guessed to use it" onConfirmed={() => load()} onCount={setGuessCount} />}
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
                    onConfirm={() => removeMotivation(g.id)} label={`Unlink ${g.display_id}`} confirmLabel={`Unlink ${g.display_id}`} />
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
                  <a href={`/tech/${o.tech}`} title={o.tech} style={{ flex: "1 1 160px", minWidth: 0 }}>{techNames[o.tech] ?? o.tech}</a>
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
              <BothWays impact={impact} name={cap.name} />
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
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>Description</span>
              <textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                style={{ padding: "8px 10px", fontSize: "var(--text-sm)", fontFamily: "var(--font-body)", color: "var(--text-heading)", background: "var(--surface-card)", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)", resize: "vertical" }} />
            </label>
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

// A capability can sit on both lists without any loop: features of it need
// features of this one, and other features of it are needed by them (or one
// feature is built on both). Say so, so the owner doesn't read a cycle.
function BothWays({ impact, name }) {
  const needed = new Set(impact.dependencies.map((c) => c.id));
  const both = impact.dependents.filter((c) => needed.has(c.id)).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  if (both.length === 0) return null;
  return (
    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
      On both lists: {andList(both)}. Some of {both.length === 1 ? "its" : "their"} features need a feature built on {name};
      others are needed by one. That is two links, not a loop.
    </div>
  );
}

function ImpactList({ title, items }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={SUBHEAD}>{title}</div>
      {[...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((c) => (
        <a key={c.id} href={`/capabilities/${c.slug}`} style={{ fontSize: "var(--text-sm)" }}>{c.name}</a>
      ))}
    </div>
  );
}
