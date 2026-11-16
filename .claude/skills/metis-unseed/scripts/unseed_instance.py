#!/usr/bin/env python3
"""Remove entities named in a metis-seed JSON file from a running metis instance.

The inverse of seed_instance.py. Stdlib only — no dependencies. Entities are
matched exactly the way the loader matches them (goals by type+title;
capabilities, features, and products by name; edges by src+dst+kind;
motivations by pair) and deleted via the REST API.

Entities entangled with material outside the seed are kept, with a warning:

- a product is kept if features outside the seed belong to it
- a capability is kept if foreign features realize it (any of a feature's
  capability_ids counts), or if any child
  capability is foreign or itself kept
- a goal is kept if it has foreign child goals or foreign products

Deleting a feature cascades its edges — including edges foreign features had
to it (reported as notes). Deleting a product cascades its PRD and all work
items, including tickets created after seeding.

Usage:
    python3 unseed_instance.py metis-seed.json [--base-url http://localhost:8000] [--dry-run]

Exit codes: 0 clean, 1 file/connection error, 2 finished but some entities
were kept or failed (see warnings).
"""

import argparse
import json
import sys
import urllib.error
import urllib.request


class Api:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")

    def request(self, method, path, payload=None):
        url = f"{self.base}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                return resp.status, json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            try:
                body = json.loads(body)
            except ValueError:
                pass
            return e.code, body
        except urllib.error.URLError as e:
            sys.exit(
                f"error: cannot reach {url}: {e.reason}\n"
                "Is the instance up? From the metis repo: docker compose up -d (API on :8000)"
            )

    def get(self, path):
        status, body = self.request("GET", path)
        if status != 200:
            sys.exit(f"error: GET {path} returned {status}: {body}")
        return body

    def get_optional(self, path):
        """For endpoints an older instance may not have yet. Absent is [],
        which is the same thing as "nothing there" for every caller."""
        status, body = self.request("GET", path)
        return body if status == 200 else []

    def delete(self, path):
        return self.request("DELETE", path)


class Unseeder:
    def __init__(self, api, doc, dry_run):
        self.api = api
        self.doc = doc
        self.dry_run = dry_run
        self.counts = {}  # (collection, action) -> int
        self.notes = []  # informational (e.g. cascaded foreign edges)
        self.warnings = []  # kept or failed entities — exit 2

        # instance state, fetched once
        self.inst_goals = api.get("/api/goals")
        self.inst_caps = api.get("/api/capabilities")
        self.inst_feats = api.get("/api/features")
        self.inst_edges = api.get("/api/features/edges")
        self.inst_prods = api.get("/api/products")
        # Buy-side supply. A seed carries no tech, so any satisfaction on a
        # seeded capability was recorded by someone else — it is shared state,
        # like a foreign feature, and the capability is kept rather than
        # deleted. Older instances predate the endpoint; treat that as none.
        self.inst_sats = api.get_optional("/api/tech/satisfactions")

        # seed ref -> matched instance entity
        self.goals = self._match(
            "goals", lambda g: (g.get("goal_type"), g.get("title")),
            {(g["goal_type"], g["title"]): g for g in self.inst_goals},
            lambda g: g.get("title"),
        )
        self.caps = self._match(
            "capabilities", lambda c: c.get("name"),
            {c["name"]: c for c in self.inst_caps},
            lambda c: c.get("name"),
        )
        self.feats = self._match(
            "features", lambda f: f.get("name"),
            {f["name"]: f for f in self.inst_feats},
            lambda f: f.get("name"),
        )
        self.prods = self._match(
            "products", lambda p: p.get("name"),
            {p["name"]: p for p in self.inst_prods},
            lambda p: p.get("name"),
        )

    def _match(self, collection, key, existing, label):
        matched = {}
        for item in self.doc.get(collection) or []:
            inst = existing.get(key(item))
            if inst is None:
                self.note(collection, "absent")
            elif item.get("ref"):
                matched[item["ref"]] = inst
        return matched

    def note(self, collection, action):
        self.counts[(collection, action)] = self.counts.get((collection, action), 0) + 1

    def remove(self, collection, path, label):
        if self.dry_run:
            self.note(collection, "would delete")
            print(f"  would delete {label}")
            return
        status, body = self.api.delete(path)
        if status == 204:
            self.note(collection, "deleted")
            print(f"  deleted {label}")
        elif status == 404:
            self.note(collection, "absent")
        else:
            self.note(collection, "failed")
            self.warnings.append(f"{label}: DELETE returned {status}: {body}")

    # ---- guards: what must be kept because foreign material hangs off it ----

    def keep(self, collection, label, reasons):
        self.note(collection, "kept")
        self.warnings.append(f"kept {label}: " + "; ".join(reasons))

    def deletable_caps(self):
        """Matched capabilities safe to delete, leaves before parents."""
        matched_ids = {c["id"] for c in self.caps.values()}
        matched_feat_ids = {f["id"] for f in self.feats.values()}
        children, feats_of, sats_of = {}, {}, {}
        for c in self.inst_caps:
            children.setdefault(c["parent_id"], []).append(c)
        for f in self.inst_feats:
            for cid in f.get("capability_ids") or []:
                feats_of.setdefault(cid, []).append(f)
        for s in self.inst_sats:
            sats_of.setdefault(s["capability_id"], []).append(s)

        verdict = {}  # cap id -> bool

        def check(cap):
            cid = cap["id"]
            if cid in verdict:
                return verdict[cid]
            reasons = []
            foreign_feats = [
                f for f in feats_of.get(cid, []) if f["id"] not in matched_feat_ids
            ]
            if foreign_feats:
                reasons.append(f"{len(foreign_feats)} feature(s) outside the seed realize it")
            sats = sats_of.get(cid, [])
            if sats:
                reasons.append(
                    f"{len(sats)} technolog(ies) satisfy it — remove the satisfactions "
                    "first if you really mean to drop it"
                )
            for child in children.get(cid, []):
                if child["id"] not in matched_ids:
                    reasons.append(f"child capability {child['name']!r} is not in the seed")
                elif not check(child):
                    reasons.append(f"child capability {child['name']!r} is kept")
            verdict[cid] = not reasons
            if reasons:
                self.keep("capabilities", f"capability {cap['name']!r}", reasons)
            return verdict[cid]

        deletable = [c for c in self.caps.values() if check(c)]
        # leaves first: deeper capabilities before their parents
        by_id = {c["id"]: c for c in self.inst_caps}

        def depth(c):
            d, node = 0, c
            while node.get("parent_id") and node["parent_id"] in by_id:
                d, node = d + 1, by_id[node["parent_id"]]
            return d

        return sorted(deletable, key=depth, reverse=True)

    def deletable_goals(self):
        """Matched goals safe to delete, children before parents."""
        matched_ids = {g["id"] for g in self.goals.values()}
        # Products kept for their foreign features count as foreign here too.
        matched_prod_ids = {p["id"] for p in self.prods.values()} - set(
            self.foreign_feature_counts()
        )
        children = {}
        for g in self.inst_goals:
            children.setdefault(g["parent_goal_id"], []).append(g)

        verdict = {}

        def check(goal):
            gid = goal["id"]
            if gid in verdict:
                return verdict[gid]
            reasons = []
            for child in children.get(gid, []):
                if child["id"] not in matched_ids:
                    reasons.append(f"child goal {child['title']!r} is not in the seed")
                elif not check(child):
                    reasons.append(f"child goal {child['title']!r} is kept")
            foreign_prods = [
                p
                for p in self.inst_prods
                if p["goal_id"] == gid and p["id"] not in matched_prod_ids
            ]
            for p in foreign_prods:
                reasons.append(f"product {p['name']!r} outside the seed points at it")
            verdict[gid] = not reasons
            if reasons:
                self.keep("goals", f"goal {goal['title']!r}", reasons)
            return verdict[gid]

        deletable = [g for g in self.goals.values() if check(g)]
        by_id = {g["id"]: g for g in self.inst_goals}

        def depth(g):
            d, node = 0, g
            while node.get("parent_goal_id") and node["parent_goal_id"] in by_id:
                d, node = d + 1, by_id[node["parent_goal_id"]]
            return d

        return sorted(deletable, key=depth, reverse=True)

    # ---- removal passes, safest order ----

    def remove_motivations(self):
        for m in self.doc.get("motivations") or []:
            goal = self.goals.get(m.get("goal_ref"))
            cap = self.caps.get(m.get("capability_ref"))
            if goal is None or cap is None:
                self.note("motivations", "absent")
                continue
            existing = {g["id"] for g in self.api.get(f"/api/capabilities/{cap['id']}/motivations")}
            if goal["id"] not in existing:
                self.note("motivations", "absent")
                continue
            self.remove(
                "motivations",
                f"/api/capabilities/{cap['id']}/motivations/{goal['id']}",
                f"motivation {goal['title']!r} -> {cap['name']!r}",
            )

    def remove_edges(self):
        by_key = {(e["src_id"], e["dst_id"], e["kind"]): e for e in self.inst_edges}
        for e in self.doc.get("edges") or []:
            kind = e.get("kind", "DEPENDS_ON")
            src = self.feats.get(e.get("src_ref"))
            dst = self.feats.get(e.get("dst_ref"))
            inst = by_key.get((src["id"], dst["id"], kind)) if src and dst else None
            if inst is None:
                self.note("edges", "absent")
                continue
            self.remove(
                "edges",
                f"/api/features/edges/{inst['id']}",
                f"edge {src['name']!r} -{kind}-> {dst['name']!r}",
            )

    def foreign_feature_counts(self):
        """Matched product id -> number of features outside the seed that belong
        to it. Deleting such a product would silently orphan them (product_id
        SET NULL), so it is shared state and kept."""
        matched_feat_ids = {f["id"] for f in self.feats.values()}
        matched_prod_ids = {p["id"] for p in self.prods.values()}
        counts = {}
        for f in self.inst_feats:
            pid = f.get("product_id")
            if pid in matched_prod_ids and f["id"] not in matched_feat_ids:
                counts[pid] = counts.get(pid, 0) + 1
        return counts

    def remove_products(self):
        foreign = self.foreign_feature_counts()
        for prod in self.prods.values():
            if prod["id"] in foreign:
                self.keep(
                    "products",
                    f"product {prod['name']!r}",
                    [f"{foreign[prod['id']]} feature(s) outside the seed belong to it"],
                )
                continue
            self.remove(
                "products",
                f"/api/products/{prod['id']}",
                f"product {prod['name']!r} (cascades its PRD and work items)",
            )

    def remove_features(self):
        matched_ids = {f["id"] for f in self.feats.values()}
        names = {f["id"]: f["name"] for f in self.inst_feats}
        for e in self.inst_edges:
            src_in, dst_in = e["src_id"] in matched_ids, e["dst_id"] in matched_ids
            if src_in != dst_in:
                self.notes.append(
                    f"edge {names.get(e['src_id'])!r} -{e['kind']}-> "
                    f"{names.get(e['dst_id'])!r} crosses the seed boundary; "
                    "it goes away with the deleted endpoint"
                )
        for feat in self.feats.values():
            self.remove(
                "features", f"/api/features/{feat['id']}", f"feature {feat['name']!r}"
            )

    def remove_capabilities(self):
        for cap in self.deletable_caps():
            self.remove(
                "capabilities",
                f"/api/capabilities/{cap['id']}",
                f"capability {cap['name']!r}",
            )

    def remove_goals(self):
        for goal in self.deletable_goals():
            self.remove("goals", f"/api/goals/{goal['id']}", f"goal {goal['title']!r}")

    def report(self):
        order = ["motivations", "edges", "products", "features", "capabilities", "goals"]
        for collection in order:
            actions = {a: n for (c, a), n in self.counts.items() if c == collection}
            if actions:
                detail = ", ".join(f"{n} {a}" for a, n in sorted(actions.items()))
                print(f"  {collection:16} {detail}")
        for n in self.notes:
            print(f"  note: {n}")
        for w in self.warnings:
            print(f"  warning: {w}")


def main():
    ap = argparse.ArgumentParser(
        description="Remove entities named in a metis-seed JSON file from a running instance."
    )
    ap.add_argument("seed_file")
    ap.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="metis API base URL (default: %(default)s)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="resolve and list what would be deleted without deleting anything",
    )
    args = ap.parse_args()

    try:
        with open(args.seed_file) as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit(f"error: cannot read {args.seed_file}: {e}")

    if doc.get("format") != "metis-seed/v1":
        sys.exit(f"error: {args.seed_file}: 'format' must be \"metis-seed/v1\"")

    api = Api(args.base_url)
    status, _ = api.request("GET", "/api/health")
    if status != 200:
        sys.exit(f"error: {args.base_url}/api/health returned {status} — is the instance up?")

    unseeder = Unseeder(api, doc, args.dry_run)
    unseeder.remove_motivations()
    unseeder.remove_edges()
    unseeder.remove_products()
    unseeder.remove_features()
    unseeder.remove_capabilities()
    unseeder.remove_goals()

    print(("dry run — nothing deleted" if args.dry_run else "unseed complete") + ":")
    unseeder.report()
    if unseeder.warnings:
        sys.exit(2)


if __name__ == "__main__":
    main()
