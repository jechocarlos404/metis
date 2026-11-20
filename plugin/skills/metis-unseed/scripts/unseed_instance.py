#!/usr/bin/env python3
"""Remove entities named in a metis-seed JSON file from a running metis instance.

The inverse of seed_instance.py. Stdlib only — no dependencies. Entities are
matched exactly the way the loader matches them (goals by type+title;
capabilities by slug; products by name, features by (product, name);
technologies by slug; edges by src+dst+kind; motivations and satisfactions by
pair) and deleted via the REST API.

Entities entangled with material outside the seed are kept, with the reason:

- a product is kept if features outside the seed belong to it
- a technology is kept if a product outside the seed uses it, if it has an
  adoption stance, or if it satisfies (or is guessed to satisfy) a capability
  the seed does not link it to
- a capability is kept if foreign features realize it (any of a feature's
  capability_ids counts), if a foreign feature or technology links to it
  (confirmed or guessed), or if any child capability is foreign or itself kept
- a goal is kept if it has foreign child goals or foreign products
- a goal link (motivation) the seed does not declare keeps whichever of its
  ends the seed names, the goal and the capability; so does a capability
  another product added by hand (a bundle). Deleting either end would take
  the link with it, and the seed never made it

Every row a delete takes with it is listed first: a deleted feature's edges
(including ones the seed does not declare, or that foreign features had to it)
are deleted one by one, and its guesses are named on its line. Deleting a product cascades its
PRD, all work items (including tickets created after seeding) and its
technology usage. Deleting a technology cascades its satisfactions and guesses.

With auth on, pass a token (--token, or METIS_TOKEN / METIS_API_TOKEN). Any
valid token can run --dry-run; a delete needs a person's desktop session, which
no script can get, so remove the product in the app instead (Settings, Seed
files).

Usage:
    python3 unseed_instance.py metis-seed.json [--base-url http://localhost:8000] [--dry-run] [--token TOKEN]

Kept rows are the designed outcome, listed with their reasons. If this
token cannot read guesses (editors and admins only), a dry run says "can't
tell" for every capability and technology a guess could keep, and a real run
refuses before deleting anything.

Exit codes: 0 finished (kept rows included), 1 file/connection error or
refusal, 2 finished but some deletes failed (see warnings).
"""

import argparse
import os
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


IN_APP = (
    "Deletes need a person's desktop session, which no script can get: remove "
    "it in the app instead (Settings, Seed files: preview, then remove), or run "
    "against an instance started with AUTH_ENABLED=false."
)


def refused(method, path, status, body, token):
    """Exit with a plain message when the API refuses the caller. A 403 on a
    read is left to the caller: the guesses list is editor-only, and a dry run
    with a read-only token reads it as empty."""
    if status == 401:
        why = "the token was refused (expired? they last 5 minutes)" if token else "no token was sent"
        sys.exit(
            f"error: {method} {path} returned 401: the API has auth on and {why}. "
            "Pass --token or set METIS_TOKEN; see the skill's SKILL.md, \"With auth on\"."
        )
    if status == 403 and method != "GET":
        detail = body.get("detail") if isinstance(body, dict) else body
        if isinstance(detail, dict) and detail.get("error") == "human_action_required":
            sys.exit(f"error: {method} {path} returned 403: this token can read but not delete. {IN_APP}")
        sys.exit(f"error: {method} {path} returned 403 ({detail}). {IN_APP}")


class Api:
    def __init__(self, base_url, token=None):
        self.base = base_url.rstrip("/")
        self.token = token

    def request(self, method, path, payload=None):
        url = f"{self.base}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
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
            refused(method, path, e.code, body, self.token)
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
        """For endpoints an older instance may not have yet: a 404 is [].
        Any other refusal is None, so the caller can say it couldn't tell."""
        status, body = self.request("GET", path)
        if status == 200:
            return body
        return [] if status == 404 else None

    def delete(self, path):
        return self.request("DELETE", path)


def tech_slug(tech):
    """The loader's technology identity: explicit slug, else the backend's
    slug rule applied to the name."""
    if tech.get("slug") is not None:
        return tech["slug"]
    return re.sub(r"[^a-z0-9]+", "-", str(tech.get("name", "")).strip().lower()).strip("-")


def capability_resolver(instance):
    """The loader's capability identity: the explicit slug, then the slug the
    name derives, then that derived slug against each row's current name (a
    rename keeps the old slug), preferring the row with exactly that name."""
    def slugify(value):
        return tech_slug({"name": value})

    by_slug = {c["slug"]: c for c in instance}
    by_name = {}
    for c in instance:
        by_name.setdefault(slugify(c["name"]), []).append(c)

    def resolve(cap):
        if cap.get("slug") is not None and cap["slug"] in by_slug:
            return by_slug[cap["slug"]]
        derived = slugify(cap.get("name", ""))
        if derived in by_slug:
            return by_slug[derived]
        rows = by_name.get(derived) or []
        return next((r for r in rows if r["name"] == cap.get("name")), rows[0] if rows else None)

    return resolve


class Unseeder:
    def __init__(self, api, doc, dry_run):
        self.api = api
        self.doc = doc
        self.dry_run = dry_run
        self.counts = {}  # (collection, action) -> int
        self.notes = []  # informational: kept rows and their reasons
        self.warnings = []  # failed deletes — exit 2
        self.unreadable = []  # lists this token cannot read

        # instance state, fetched once
        self.inst_goals = api.get("/api/goals")
        self.inst_caps = api.get("/api/capabilities")
        self.inst_feats = api.get("/api/features")
        self.inst_edges = api.get("/api/features/edges")
        self.inst_prods = api.get("/api/products")
        # Goal links and hand-added capabilities: a capability's delete
        # cascades both, so each is either in the seed or holds its row back.
        self.inst_motivations = api.get("/api/motivations")
        self.inst_bundles = api.get("/api/product-bundles")
        # Buy-side supply and guesses. A satisfaction or guess the seed did not
        # declare was recorded by someone else; it is shared state, like a
        # foreign feature, and the capability is kept rather than deleted.
        # Older instances predate these endpoints (404: none).
        self.inst_sats = self._optional("/api/tech/satisfactions", "technology links")
        self.inst_guesses = self._optional("/api/guesses", "guesses")
        self.inst_techs = self._all_technologies()

        # seed ref -> matched instance entity
        self.goals = self._match(
            "goals", lambda g: (g.get("goal_type"), g.get("title")),
            {(g["goal_type"], g["title"]): g for g in self.inst_goals},
            lambda g: g.get("title"),
        )
        resolve_capability = capability_resolver(self.inst_caps)
        self.caps = self._match(
            "capabilities", lambda c: (resolve_capability(c) or {}).get("id"),
            {c["id"]: c for c in self.inst_caps},
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
            p["id"]: self._optional(f"/api/stacks/usage?product_id={p['id']}", "technology use")
            for p in self.prods.values()
        }
        # (tech id, capability id) pairs the seed itself declares, confirmed
        # or guessed: removing those is undoing the seed, not foreign data.
        self.declared = set()
        for t in self.doc.get("technologies") or []:
            tech = self.techs.get(t.get("ref"))
            for sat in t.get("satisfies") or []:
                cap = self.caps.get(sat.get("capability_ref"))
                if tech and cap:
                    self.declared.add((tech["id"], cap["id"]))
        # Goal links the instance has that the seed does not declare, on a
        # goal or capability the seed names. Someone else made them: each
        # keeps both of its ends, so no delete cascades into one unlisted.
        declared_links = set()
        for m in self.doc.get("motivations") or []:
            goal = self.goals.get(m.get("goal_ref"))
            cap = self.caps.get(m.get("capability_ref"))
            if goal and cap:
                declared_links.add((goal["id"], cap["id"]))
        goal_ids = {g["id"] for g in self.goals.values()}
        cap_ids = {c["id"] for c in self.caps.values()}
        self.foreign_links = [
            m for m in self.inst_motivations
            if (m["goal_id"], m["capability_id"]) not in declared_links
            and (m["goal_id"] in goal_ids or m["capability_id"] in cap_ids)
        ]
        if self.unreadable:
            what = " or ".join(self.unreadable)
            if not dry_run:
                sys.exit(
                    f"error: this token cannot read {what}, so it cannot tell which "
                    "capabilities and technologies are safe to delete. Nothing was deleted. " + IN_APP
                )
            msg = (
                f"this token cannot read {what}"
                + (" (editors and admins only)" if "guesses" in self.unreadable else "")
                + ", and those can keep a capability or technology, so where the removal "
                "depends on them this dry run says \"can't tell\" instead of \"would delete\""
            )
            print(f"  note: {msg}")
            self.notes.append(msg)

    def _optional(self, path, what):
        """A list an older instance may lack (404: none), or this token may
        not read. Unreadable, it is recorded: a dry run then can't tell what
        it would keep, and a real run refuses."""
        rows = self.api.get_optional(path)
        if rows is None and what not in self.unreadable:
            self.unreadable.append(what)
        return rows or []

    def _goal_name(self, goal_id):
        goal = next((g for g in self.inst_goals if g["id"] == goal_id), None)
        if goal is None:
            return goal_id
        return f"{goal['display_id']} {goal['title']!r}" if goal.get("display_id") else repr(goal["title"])

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

    def remove(self, collection, path, label, unsure=False):
        """`unsure`: the delete depends on a capability or technology that a
        list this token can't read might keep, so a dry run says so instead
        of claiming it."""
        if self.dry_run:
            if unsure and self.unreadable:
                self.note(collection, "can't tell")
                print(f"  can't tell whether {label} goes")
                return
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
        """Kept is the designed outcome for shared rows: listed with its
        reasons, not a warning."""
        self.note(collection, "kept")
        self.notes.append(f"kept {label}: " + "; ".join(reasons))

    def deletable_caps(self):
        """Matched capabilities safe to delete, leaves before parents."""
        matched_ids = {c["id"] for c in self.caps.values()}
        matched_feat_ids = {f["id"] for f in self.feats.values()}
        dead_techs = self._dead("techs")
        foreign = self.foreign_feature_counts()
        dead_prods = {p["id"] for p in self.prods.values() if p["id"] not in foreign}
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
            goal_links = [m for m in self.foreign_links if m["capability_id"] == cid]
            if goal_links:
                names = ", ".join(self._goal_name(m["goal_id"]) for m in goal_links)
                reasons.append(f"goal(s) {names} link to it, link(s) the seed does not have")
            for b in self.inst_bundles:
                if b["capability_id"] == cid and b["product_id"] not in dead_prods:
                    reasons.append(f"product {b['product_name']!r} lists it as a capability added by hand")
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
            cap_links = [m for m in self.foreign_links if m["goal_id"] == gid]
            if cap_links:
                names = ", ".join(repr(m["capability_name"]) for m in cap_links)
                reasons.append(f"it links to capability(ies) {names}, link(s) the seed does not have")
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
        existing = {(m["goal_id"], m["capability_id"]) for m in self.inst_motivations}
        for m in self.doc.get("motivations") or []:
            goal = self.goals.get(m.get("goal_ref"))
            cap = self.caps.get(m.get("capability_ref"))
            if goal is None or cap is None or (goal["id"], cap["id"]) not in existing:
                self.note("motivations", "absent")
                continue
            label = f"motivation {goal['title']!r} -> {cap['name']!r}"
            goal_dies = goal["id"] in self._dead("goals")
            # Both ends survive: the pair is someone else's too (another
            # product's seed motivated the same capability by the same goal).
            if cap["id"] not in self._dead("caps") and not goal_dies:
                self.keep("motivations", label, ["the goal and the capability both stay"])
                continue
            self.remove(
                "motivations",
                f"/api/capabilities/{cap['id']}/motivations/{goal['id']}",
                label,
                unsure=not goal_dies,
            )

    def remove_edges(self):
        """The seed's own edges, then every other edge a deleted feature has:
        those would go with the feature anyway, so each is named here first."""
        by_key = {(e["src_id"], e["dst_id"], e["kind"]): e for e in self.inst_edges}
        handled = set()
        for e in self.doc.get("edges") or []:
            kind = e.get("kind", "DEPENDS_ON")
            src = self.feats.get(e.get("src_ref"))
            dst = self.feats.get(e.get("dst_ref"))
            inst = by_key.get((src["id"], dst["id"], kind)) if src and dst else None
            if inst is None:
                self.note("edges", "absent")
                continue
            handled.add(inst["id"])
            self.remove(
                "edges",
                f"/api/features/edges/{inst['id']}",
                f"edge {src['name']!r} -{kind}-> {dst['name']!r}",
            )
        matched_ids = {f["id"] for f in self.feats.values()}
        names = {f["id"]: f["name"] for f in self.inst_feats}
        for e in self.inst_edges:
            src_in, dst_in = e["src_id"] in matched_ids, e["dst_id"] in matched_ids
            if e["id"] in handled or not (src_in or dst_in):
                continue
            if src_in and dst_in:
                why = "not in the seed; it goes with its features"
            else:
                outside = names.get(e["dst_id"] if src_in else e["src_id"])
                why = f"feature {outside!r} is outside the seed; the edge goes with the deleted one"
            self.remove(
                "edges",
                f"/api/features/edges/{e['id']}",
                f"edge {names.get(e['src_id'])!r} -{e['kind']}-> {names.get(e['dst_id'])!r} ({why})",
            )

    def foreign_feature_counts(self):
        """Matched product id -> number of features outside the seed that belong
        to it. Deleting such a product would delete them with it, so it is
        shared state and kept."""
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
            # What goes with it: its own rows, named so none goes unlisted.
            by_hand = sum(1 for b in self.inst_bundles if b["product_id"] == prod["id"])
            uses = len(self.inst_usage.get(prod["id"], []))
            parts = ["its PRD", "work items"]
            if uses:
                parts.append(f"{uses} technology usage row(s)")
            if by_hand:
                parts.append(f"{by_hand} hand-added capability link(s)")
            self.remove(
                "products",
                f"/api/products/{prod['id']}",
                f"product {prod['name']!r} (cascades {', '.join(parts[:-1])} and {parts[-1]})",
            )

    def remove_features(self):
        for feat in self.feats.values():
            guesses = sum(1 for g in self.inst_guesses if g.get("feature_id") == feat["id"])
            self.remove(
                "features",
                f"/api/features/{feat['id']}",
                f"feature {feat['name']!r}" + (f" (cascades its {guesses} guess(es))" if guesses else ""),
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
                unsure=True,
            )
        dead_techs, dead_caps = self._dead("techs"), self._dead("caps")
        cap_names = {c["id"]: c["name"] for c in self.inst_caps}
        for s in self.inst_sats:
            pair = (s["tech_id"], s["capability_id"])
            if s["tech_id"] in dead_techs or pair not in self.declared:
                continue
            label = f"satisfaction of {cap_names.get(s['capability_id'])!r}"
            if s["capability_id"] not in dead_caps:
                self.keep("satisfactions", label, ["the technology and the capability both stay"])
                continue
            self.remove("satisfactions", f"/api/tech/satisfactions/{s['id']}", label, unsure=True)

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
                unsure=True,
            )

    def remove_goals(self):
        self._dead("goals")
        for goal in self._dead_cache["goals"]:
            self.remove("goals", f"/api/goals/{goal['id']}", f"goal {goal['title']!r}")

    def report(self):
        order = [
            "motivations", "edges", "features", "products", "technologies",
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
    ap.add_argument(
        "--token",
        default=os.environ.get("METIS_TOKEN") or os.environ.get("METIS_API_TOKEN"),
        help="bearer token for an instance with auth on (default: $METIS_TOKEN, "
        "else $METIS_API_TOKEN). Any valid token can --dry-run; deletes need a "
        "desktop session, so with auth on remove it in the app instead",
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

    api = Api(args.base_url, args.token)
    status, _ = api.request("GET", "/api/health")
    if status != 200:
        sys.exit(f"error: {args.base_url}/api/health returned {status} — is the instance up?")

    unseeder = Unseeder(api, doc, args.dry_run)
    unseeder.remove_motivations()
    unseeder.remove_edges()
    # Features before their product: a product's delete takes its features,
    # so each is deleted, and listed, by itself first.
    unseeder.remove_features()
    unseeder.remove_products()
    unseeder.remove_technologies()
    unseeder.remove_capabilities()
    unseeder.remove_goals()

    print(("dry run — nothing deleted" if args.dry_run else "unseed complete") + ":")
    unseeder.report()
    if unseeder.warnings:
        sys.exit(2)


if __name__ == "__main__":
    main()
