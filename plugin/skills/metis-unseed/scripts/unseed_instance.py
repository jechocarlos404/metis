#!/usr/bin/env python3
"""Remove entities named in a metis-seed JSON file from a running metis instance.

The inverse of seed_instance.py. Stdlib only — no dependencies. Entities are
matched exactly the way the loader matches them (goals by type+title;
capabilities and products by name, features by (product, name); technologies
by slug; edges by src+dst+kind; motivations and satisfactions by pair) and
deleted via the REST API.

Entities entangled with material outside the seed are kept, with a warning:

- a product is kept if features outside the seed belong to it
- a technology is kept if a product outside the seed uses it, if it has an
  adoption stance, or if it satisfies (or is guessed to satisfy) a capability
  the seed does not link it to
- a capability is kept if foreign features realize it (any of a feature's
  capability_ids counts), if a foreign feature or technology links to it
  (confirmed or guessed), or if any child capability is foreign or itself kept
- a goal is kept if it has foreign child goals or foreign products

Deleting a feature cascades its edges (including edges foreign features had
to it, reported as notes) and its guesses. Deleting a product cascades its
PRD, all work items (including tickets created after seeding) and its
technology usage. Deleting a technology cascades its satisfactions and guesses.

Usage:
    python3 unseed_instance.py metis-seed.json [--base-url http://localhost:8000] [--dry-run]

Exit codes: 0 clean, 1 file/connection error, 2 finished but some entities
were kept or failed (see warnings).
"""

import argparse
import os
import json
import re
import sys
import urllib.error
import urllib.parse
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


def tech_slug(tech):
    """The loader's technology identity: explicit slug, else the backend's
    slug rule applied to the name."""
    if tech.get("slug") is not None:
        return tech["slug"]
    return re.sub(r"[^a-z0-9]+", "-", str(tech.get("name", "")).strip().lower()).strip("-")


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
        # Buy-side supply and guesses. A satisfaction or guess the seed did not
        # declare was recorded by someone else; it is shared state, like a
        # foreign feature, and the capability is kept rather than deleted.
        # Older instances predate these endpoints; treat that as none.
        self.inst_sats = api.get_optional("/api/tech/satisfactions")
        self.inst_guesses = api.get_optional("/api/guesses")
        self.inst_techs = self._all_technologies()

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
        self.prods = self._match(
            "products", lambda p: p.get("name"),
            {p["name"]: p for p in self.inst_prods},
            lambda p: p.get("name"),
        )
        # A feature is its product's: identity is (product, name), so two
        # products may each have a "Sign in" without one unseed taking both.
        self.feats = self._match(
            "features",
            lambda f: ((self.prods.get(f.get("product_ref")) or {}).get("id"), f.get("name")),
            {(f.get("product_id"), f["name"]): f for f in self.inst_feats},
            lambda f: f.get("name"),
        )
        self.techs = self._match(
            "technologies", tech_slug,
            {t["slug"]: t for t in self.inst_techs},
            lambda t: t.get("name"),
        )
        # Usage of the seed's products, read now: deleting a product cascades
        # its usage rows, and the technology guard runs after that.
        self.inst_usage = {
            p["id"]: api.get_optional(f"/api/stacks/usage?product_id={p['id']}")
            for p in self.prods.values()
        } if self.techs else {}
        # (tech id, capability id) pairs the seed itself declares, confirmed
        # or guessed: removing those is undoing the seed, not foreign data.
        self.declared = set()
        for t in self.doc.get("technologies") or []:
            tech = self.techs.get(t.get("ref"))
            for sat in t.get("satisfies") or []:
                cap = self.caps.get(sat.get("capability_ref"))
                if tech and cap:
                    self.declared.add((tech["id"], cap["id"]))

    def _all_technologies(self):
        rows, offset = [], 0
        while True:
            status, page = self.api.request("GET", f"/api/tech?limit=200&offset={offset}")
            if status != 200:
                return rows
            rows.extend(page["rows"])
            offset += 200
            if offset >= page["total"] or not page["rows"]:
                return rows

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
        dead_techs = self._dead("techs")
        children, feats_of, sats_of, guesses_of = {}, {}, {}, {}
        for c in self.inst_caps:
            children.setdefault(c["parent_id"], []).append(c)
        for f in self.inst_feats:
            for cid in f.get("capability_ids") or []:
                feats_of.setdefault(cid, []).append(f)
        for s in self.inst_sats:
            # Gone with its technology, or the seed's own (removed before
            # the capability): neither holds the capability back.
            if s["tech_id"] in dead_techs or (s["tech_id"], s["capability_id"]) in self.declared:
                continue
            sats_of.setdefault(s["capability_id"], []).append(s)
        for g in self.inst_guesses:
            if g.get("feature_id") in matched_feat_ids or g.get("tech_id") in dead_techs:
                continue
            if g.get("tech_id") and (g["tech_id"], g["capability_id"]) in self.declared:
                continue
            guesses_of.setdefault(g["capability_id"], []).append(g)

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
            guesses = guesses_of.get(cid, [])
            if guesses:
                reasons.append(f"{len(guesses)} guessed link(s) from outside the seed point at it")
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

    def deletable_techs(self):
        """Matched technologies safe to delete."""
        foreign = self.foreign_feature_counts()
        dead_prods = [p["id"] for p in self.prods.values() if p["id"] not in foreign]
        seed_users = {}  # tech id -> how many deleted seed products use it
        for pid in dead_prods:
            for u in self.inst_usage.get(pid, []):
                seed_users[u["tech_id"]] = seed_users.get(u["tech_id"], 0) + 1
        cap_names = {c["id"]: c["name"] for c in self.inst_caps}
        deletable = []
        for tech in self.techs.values():
            tid, reasons = tech["id"], []
            others = (tech.get("used_by") or 0) - seed_users.get(tid, 0)
            if others > 0:
                reasons.append(f"{others} product(s) outside the seed use it")
            if tech.get("adoption"):
                reasons.append(f"it has an adoption stance ({tech['adoption']})")
            links = [(s["capability_id"], "satisfies") for s in self.inst_sats if s["tech_id"] == tid]
            links += [
                (g["capability_id"], "is guessed to satisfy")
                for g in self.inst_guesses
                if g.get("tech_id") == tid
            ]
            for cid, verb in links:
                if (tid, cid) not in self.declared:
                    reasons.append(f"{verb} {cap_names.get(cid, cid)!r}, which the seed does not say")
            if reasons:
                self.keep("technologies", f"technology {tech['name']!r}", reasons)
            else:
                deletable.append(tech)
        return deletable

    def _dead(self, kind):
        """Ids the technology/capability/goal passes will delete, computed
        once: the deletable_* checks record keep-warnings, so they must not
        run twice."""
        cache = self.__dict__.setdefault("_dead_cache", {})
        if kind not in cache:
            rows = {
                "techs": self.deletable_techs,
                "caps": self.deletable_caps,
                "goals": self.deletable_goals,
            }[kind]()
            cache[kind] = rows
        return {r["id"] for r in cache[kind]}

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
            # Both ends survive: the pair is someone else's too (another
            # product's seed motivated the same capability by the same goal).
            if cap["id"] not in self._dead("caps") and goal["id"] not in self._dead("goals"):
                self.note("motivations", "kept")
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

    def remove_technologies(self):
        """Deletable technologies go (cascading their satisfactions, guesses
        and usage). On a kept one, the seed's confirmed satisfactions of a
        capability that is about to be deleted go first: the capability
        foreign key restricts, and the seed is what created them."""
        for tech in self._dead_cache_rows("techs"):
            self.remove(
                "technologies",
                f"/api/tech/{urllib.parse.quote(tech['slug'], safe='')}",
                f"technology {tech['name']!r} (cascades its satisfactions and guesses)",
            )
        dead_techs, dead_caps = self._dead("techs"), self._dead("caps")
        cap_names = {c["id"]: c["name"] for c in self.inst_caps}
        for s in self.inst_sats:
            pair = (s["tech_id"], s["capability_id"])
            if s["tech_id"] in dead_techs or pair not in self.declared:
                continue
            if s["capability_id"] not in dead_caps:
                self.note("satisfactions", "kept")
                continue
            self.remove(
                "satisfactions",
                f"/api/tech/satisfactions/{s['id']}",
                f"satisfaction of {cap_names.get(s['capability_id'])!r}",
            )

    def _dead_cache_rows(self, kind):
        self._dead(kind)
        return self._dead_cache[kind]

    def remove_capabilities(self):
        self._dead("caps")
        for cap in self._dead_cache["caps"]:
            self.remove(
                "capabilities",
                f"/api/capabilities/{cap['id']}",
                f"capability {cap['name']!r}",
            )

    def remove_goals(self):
        self._dead("goals")
        for goal in self._dead_cache["goals"]:
            self.remove("goals", f"/api/goals/{goal['id']}", f"goal {goal['title']!r}")

    def report(self):
        order = [
            "motivations", "edges", "products", "features", "technologies",
            "satisfactions", "capabilities", "goals",
        ]
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
    # A gaps file re-states a product's real features so new links attach to
    # them. Unseeding it would delete those features, so refuse outright.
    if (doc.get("source") or {}).get("generated_by") == "metis-fill-gaps" or os.path.basename(
        args.seed_file
    ) == "metis-seed-gaps.json":
        sys.exit(
            f"error: {args.seed_file} is a metis-fill-gaps file. Unseeding it would delete the "
            "product's real features. Remove a single link on the desktop instead."
        )

    api = Api(args.base_url)
    status, _ = api.request("GET", "/api/health")
    if status != 200:
        sys.exit(f"error: {args.base_url}/api/health returned {status} — is the instance up?")

    unseeder = Unseeder(api, doc, args.dry_run)
    unseeder.remove_motivations()
    unseeder.remove_edges()
    unseeder.remove_products()
    unseeder.remove_features()
    unseeder.remove_technologies()
    unseeder.remove_capabilities()
    unseeder.remove_goals()

    print(("dry run — nothing deleted" if args.dry_run else "unseed complete") + ":")
    unseeder.report()
    if unseeder.warnings:
        sys.exit(2)


if __name__ == "__main__":
    main()
