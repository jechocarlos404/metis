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
  adoption stance, if it satisfies (or is guessed to satisfy) a capability
  the seed does not link it to, or if people recorded who used it, a version,
  a link to another technology, or a slot of a stack that stays binds it
- a capability is kept if foreign features realize it (any of a feature's
  capability_ids counts), if a foreign feature or technology links to it
  (confirmed or guessed), if another product's epic or a surviving stack's
  slot names it, or if any child capability is foreign or itself kept
- a goal is kept if it has foreign child goals or foreign products
- a goal link (motivation) the seed does not declare keeps whichever of its
  ends the seed names, the goal and the capability; so does a capability
  another product added by hand (a bundle). Deleting either end would take
  the link with it, and the seed never made it

Every row a delete takes with it is listed first: a deleted feature's edges
(including ones the seed does not declare, or that foreign features had to it)
are deleted one by one, and its guesses are named on its line. Deleting a
product cascades its PRD, epics, stories, tickets (including ones created after
seeding), delivery strategies, technology usage, hand-added capabilities and
its own stacks, each counted on its line; rows that only pointed at it stay,
and the line says so. Deleting a technology cascades its satisfactions and
guesses, each named on its line by capability.

With auth on, pass a token (--token, or METIS_TOKEN / METIS_API_TOKEN). Any
valid token can run --dry-run; a delete needs a person signed in to the app as
an editor or admin, and this script signs no one in, so remove the product in
the app instead (Settings, Seed files).

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
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


IN_APP = (
    "Deletes need a person signed in to the app as an editor or admin, and this "
    "script signs no one in. An editor or admin can remove it in the app "
    "(Settings, Seed files: preview, then remove), or run this against an "
    "instance started with AUTH_ENABLED=false."
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
        # The role refusal: a viewer can't remove it in the app either.
        sys.exit(
            f"error: {method} {path} returned 403 ({detail}): this account can't delete, "
            "from a script or in the app; an editor or admin can. Ask one to remove it "
            "in the app (Settings, Seed files: preview, then remove)."
        )


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


def _and(names):
    """'A', 'A and B', 'A, B and C'."""
    names = list(names)
    return "".join(names) if len(names) <= 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def slugify(value):
    """The backend's slug rule: accents folded, then lowercase kebab."""
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.category(c).startswith("M")
    )
    return re.sub(r"[^a-z0-9]+", "-", folded.strip().lower()).strip("-")


def tech_slug(tech):
    """The loader's technology identity: explicit slug, else the backend's
    slug rule applied to the name."""
    if tech.get("slug") is not None:
        return tech["slug"]
    return slugify(str(tech.get("name", "")))


def capability_resolver(instance):
    """The loader's capability identity: the explicit slug, then the slug the
    name derives, then that derived slug against each row's current name (a
    rename keeps the old slug), preferring the row with exactly that name."""
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
        # Usage, read now: deleting a product cascades its usage rows, and the
        # technology guard runs after that. Every product's, since another
        # product's use can name a slot of a stack that goes.
        self.inst_usage = {
            p["id"]: self._optional(f"/api/stacks/usage?product_id={p['id']}", "technology use")
            for p in self.inst_prods
        }
        self._read_attached()
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
            # Once, before the rows it qualifies, which print as they go.
            print(f"  note: {msg}")

    def _optional(self, path, what):
        """A list an older instance may lack (404: none), or this token may
        not read. Unreadable, it is recorded: a dry run then can't tell what
        it would keep, and a real run refuses."""
        rows = self.api.get_optional(path)
        if rows is None and what not in self.unreadable:
            self.unreadable.append(what)
        return rows or []

    def _read_attached(self):
        """Rows no seed file carries that hang off what a removal deletes:
        plans, stacks, journeys, constraints, and what people recorded about a
        technology. Each one either keeps its row or is named on its line.
        Read across the whole instance: another product's epic, slot or
        journey step can point at a row the seed made."""
        self.inst_stacks = self._optional("/api/stacks", "stacks")
        self.inst_slots, self.inst_answers = [], []
        for stack in self.inst_stacks:
            view = self._optional(f"/api/stacks/{stack['id']}", "stacks")
            self.inst_slots += view.get("slots", []) if isinstance(view, dict) else []
            self.inst_answers += self._optional(f"/api/stacks/{stack['id']}/concerns", "stacks")
        self.inst_scopes = []
        for constraint in self._optional("/api/constraints", "constraints"):
            for scope in self._optional(f"/api/constraints/{constraint['id']}/scopes", "constraints"):
                self.inst_scopes.append({**scope, "constraint_name": constraint["name"]})
        self.inst_journeys = self._optional("/api/journeys", "journeys")
        self.inst_tickets = self._optional("/api/tickets", "plans")
        self.inst_epics = []
        for p in self.inst_prods:
            self.inst_epics += self._optional(f"/api/products/{p['id']}/epics", "plans")
        self.inst_plans = {
            p["id"]: self._optional(f"/api/products/{p['id']}/decompositions", "plans")
            for p in self.prods.values()
        }
        self.inst_strategies = {
            p["id"]: self._optional(f"/api/products/{p['id']}/strategies", "plans")
            for p in self.prods.values()
        }
        # Who used each technology, its versions and its links to other
        # technologies are on its own page only, so every one is read.
        self.inst_tech_detail = {}
        for t in self.inst_techs:
            detail = self._optional(f"/api/tech/{urllib.parse.quote(t['slug'], safe='')}", "technologies")
            if isinstance(detail, dict):
                self.inst_tech_detail[t["id"]] = detail

    def _dead_prod_ids(self):
        """Matched products that go: one a feature outside the seed belongs to stays."""
        foreign = self.foreign_feature_counts()
        return {p["id"] for p in self.prods.values() if p["id"] not in foreign}

    def _product_name(self, pid):
        return next((p["name"] for p in self.inst_prods if p["id"] == pid), pid)

    def _live_slots(self):
        """Slots of stacks that stay: each holds its technology and capability."""
        dead = self._dead_prod_ids()
        dead_stacks = {s["id"] for s in self.inst_stacks if s.get("product_id") in dead}
        return [s for s in self.inst_slots if s["stack_id"] not in dead_stacks]

    def _slot_label(self, slot):
        stack = next((s for s in self.inst_stacks if s["id"] == slot["stack_id"]), {})
        owner = f" of product {self._product_name(stack['product_id'])!r}" if stack.get("product_id") else ""
        return f"slot {slot['role']!r} of stack {stack.get('name', slot['stack_id'])!r}{owner}"

    def _live_epics(self):
        """Epics that stay: another product's plan, pinned to a capability."""
        dead = self._dead_prod_ids()
        return [e for e in self.inst_epics if e["product_id"] not in dead]

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
                # Absent (404) is none; any other failure is a list it can't read.
                if status != 404 and "technologies" not in self.unreadable:
                    self.unreadable.append("technologies")
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

    def note(self, collection, action, n=1):
        self.counts[(collection, action)] = self.counts.get((collection, action), 0) + n

    def remove(self, collection, path, label, unsure=False, cascades=None):
        """`unsure`: the delete depends on a capability or technology that a
        list this token can't read might keep, so a dry run says so instead
        of claiming it. `cascades`: rows of other kinds the delete takes with
        it, {kind: n}, tallied under their own kind as the in-app removal
        does, so the summary undoes an import's counts kind by kind."""
        def tally(action):
            self.note(collection, action)
            for kind, n in (cascades or {}).items():
                if n:
                    self.note(kind, action, n)

        if self.dry_run:
            if unsure and self.unreadable:
                tally("can't tell")
                print(f"  can't tell whether {label} goes")
                return
            tally("would delete")
            print(f"  would delete {label}")
            return
        status, body = self.api.delete(path)
        if status == 204:
            tally("deleted")
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
        tech_names = {t["id"]: t["name"] for t in self.inst_techs}
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
                # Direct links, of any product: what deleting the capability would cut.
                reasons.append(f"{len(foreign_feats)} feature(s) outside the seed realize it directly")
            sats = sats_of.get(cid, [])
            if sats:
                techs = _and([repr(tech_names.get(s["tech_id"], s["tech_id"])) for s in sats])
                reasons.append(f"technolog(ies) {techs} satisfy it, link(s) the seed does not have")
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
            # Another product's plan or stack names it.
            for e in self._live_epics():
                if e.get("capability_id") == cid:
                    reasons.append(
                        f"epic {e['title']!r} of product {self._product_name(e['product_id'])!r} is about it"
                    )
            for s in self._live_slots():
                if s.get("capability_id") == cid:
                    reasons.append(f"{self._slot_label(s)} answers it")
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
        tech_names = {t["id"]: t["name"] for t in self.inst_techs}
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
            # What people recorded about it, which no seed file carries.
            detail = self.inst_tech_detail.get(tid, {})
            people = list(dict.fromkeys(e["person"] for e in detail.get("encounters", [])))
            if people:
                reasons.append(f"{_and(people)} recorded using it")
            versions = [v["label"] for v in detail.get("versions", [])]
            if versions:
                reasons.append(f"it has {len(versions)} recorded version(s) ({', '.join(versions)})")
            linked = [e["dst_id"] for e in detail.get("outgoing", [])]
            linked += [e["src_id"] for e in detail.get("incoming", [])]
            if linked:
                reasons.append(f"it is linked to {_and([repr(tech_names.get(i, i)) for i in linked])}")
            described = [
                word
                for present, word in (
                    (tech.get("vendor_id"), "a vendor"),
                    (tech.get("homepage"), "a homepage"),
                    (tech.get("facets"), "facets"),
                    (tech.get("evidence_anchors"), "evidence paths"),
                )
                if present
            ]
            if described:
                reasons.append(f"it has {_and(described)}, which no seed file carries")
            for s in self._live_slots():
                if s.get("tech_id") == tid:
                    reasons.append(f"{self._slot_label(s)} uses it")
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
            label, cascades = self._product_line(prod)
            self.remove("products", f"/api/products/{prod['id']}", label, cascades=cascades)

    def _product_line(self, prod):
        """A product's delete takes its plan, stacks and the rest of its own
        rows with it; each is counted here. What only pointed at it stays,
        and says so. Returns the line and the rows of kinds an import counts."""
        pid = prod["id"]
        epics = [e for e in self.inst_epics if e["product_id"] == pid]
        epic_ids = {e["id"] for e in epics}
        story_ids = {st["id"] for e in epics for st in e.get("stories", [])}
        tickets = [t for t in self.inst_tickets if t["product_id"] == pid or t.get("epic_id") in epic_ids]
        loose = [t for t in self.inst_tickets if t not in tickets and t.get("story_id") in story_ids]
        stacks = [s for s in self.inst_stacks if s.get("product_id") == pid]
        stack_ids = {s["id"] for s in stacks}
        slot_ids = {s["id"] for s in self.inst_slots if s["stack_id"] in stack_ids}
        parts = [
            f"{n} {word}"
            for n, word in (
                (len(self.inst_plans.get(pid, [])), "plan document(s)"),
                (len(epics), "epic(s)"),
                (len(story_ids), "story(ies)"),
                (len(tickets), "ticket(s)"),
                (len(self.inst_strategies.get(pid, [])), "delivery strategy(ies)"),
                (len(self.inst_usage.get(pid, [])), "technology usage row(s)"),
                (sum(1 for b in self.inst_bundles if b["product_id"] == pid), "hand-added capability link(s)"),
            )
            if n
        ]
        for stack in stacks:
            inner = [
                f"{n} {word}"
                for n, word in (
                    (sum(1 for s in self.inst_slots if s["stack_id"] == stack["id"]), "slot(s)"),
                    (sum(1 for a in self.inst_answers if a["stack_id"] == stack["id"]), "concern answer(s)"),
                )
                if n
            ]
            parts.append(f"its stack {stack['name']!r}" + (f" with {_and(inner)}" if inner else ""))
        after = []
        scoped = [c for c in self.inst_scopes if c.get("product_id") == pid or c.get("stack_id") in stack_ids]
        for name in dict.fromkeys(c["constraint_name"] for c in scoped):
            after.append(f"constraint {name!r} stops applying to it")
        for stack in self.inst_stacks:
            if stack.get("parent_id") in stack_ids and stack["id"] not in stack_ids:
                after.append(
                    f"stack {stack['name']!r} of product {self._product_name(stack['product_id'])!r} "
                    "stays, no longer based on its stack"
                )
        via_slot = sum(
            1
            for owner, rows in self.inst_usage.items()
            if owner != pid
            for u in rows
            if u.get("via_slot_id") in slot_ids
        )
        if via_slot:
            after.append(f"{via_slot} technology usage row(s) of other products stay, no longer in its slots")
        answers = sum(1 for a in self.inst_answers if a["stack_id"] not in stack_ids and a.get("slot_id") in slot_ids)
        if answers:
            after.append(f"{answers} concern answer(s) of other stacks stay, no longer naming its slots")
        if loose:
            after.append(f"{len(loose)} ticket(s) of other products stay, no longer under its stories")
        recorded = [
            d["name"]
            for d in self.inst_tech_detail.values()
            for e in d.get("encounters", [])
            if e.get("product_id") == pid
        ]
        if recorded:
            after.append(
                f"{len(recorded)} recorded use(s) of {_and([repr(n) for n in dict.fromkeys(recorded)])} "
                "stay, no longer naming it"
            )
        # What a seed file has no place for: an import makes one plan
        # document, as a draft with every ticket pending, and never a stack
        # or a strategy.
        plans = self.inst_plans.get(pid, [])
        strategies = len(self.inst_strategies.get(pid, []))
        # The export writes the latest plan document, not the tickets as they
        # are: one edited since (its status too) or not made from it is lost.
        from_plan = {e["id"] for e in epics if plans and e.get("decomposition_id") == plans[0]["id"]}
        changed = sum(
            1 for t in tickets
            if t.get("updated_at") != t.get("created_at") or t.get("epic_id") not in from_plan
        )
        lost = [
            word
            for present, word in (
                (stacks, f"its {len(stacks)} stack(s)"),
                (strategies, f"its {strategies} delivery strategy(ies)"),
                (len(plans) > 1, f"{len(plans) - 1} older plan document(s)"),
                (prod.get("status") == "approved" or any(d.get("status") == "approved" for d in plans),
                 "its approval"),
                (changed, f"{changed} ticket(s) as they are now (changed or added since its plan was written)"),
            )
            if present
        ]
        if lost:
            after.append(f"importing this file again won't bring back {_and(lost)}")
        head = f"product {prod['name']!r}" + (f" (cascades {_and(parts)})" if parts else "")
        cascades = {
            "tech_usage": len(self.inst_usage.get(pid, [])),
            "bundles": sum(1 for b in self.inst_bundles if b["product_id"] == pid),
            "decompositions": len(plans),
        }
        return "; ".join([head, *after]), cascades

    def _feature_line(self, feat):
        """A feature's delete takes its capability links and guesses, each
        counted, and a link the seed doesn't declare named. Another product's
        story and a journey step that pointed at it stay. Returns the line and
        the rows of kinds an import counts."""
        parts = []
        links = feat.get("capability_ids") or []
        ref = next((r for r, f in self.feats.items() if f["id"] == feat["id"]), None)
        entry = next((f for f in self.doc.get("features") or [] if f.get("ref") == ref), {})
        refs = entry.get("capability_refs") or ([entry["capability_ref"]] if entry.get("capability_ref") else [])
        declared = {(self.caps.get(r) or {}).get("id") for r in refs}
        cap_names = {c["id"]: c["name"] for c in self.inst_caps}
        extra = [cid for cid in links if cid not in declared]
        if links:
            parts.append(
                f"its {len(links)} capability link(s)"
                + (f", including the link(s) to {_and([repr(cap_names.get(c, c)) for c in extra])}"
                   " the seed does not have" if extra else "")
            )
        guesses = sum(1 for g in self.inst_guesses if g.get("feature_id") == feat["id"])
        if guesses:
            parts.append(f"its {guesses} guess(es)")
        after = []
        dead = self._dead_prod_ids()
        for e in self.inst_epics:
            if e["product_id"] in dead:
                continue
            for st in e.get("stories", []):
                if st.get("feature_id") == feat["id"]:
                    after.append(
                        f"story {st['title']!r} of product {self._product_name(e['product_id'])!r} "
                        "stays, no longer about it"
                    )
        for j in self.inst_journeys:
            steps = sum(1 for st in j.get("steps", []) if st.get("feature_id") == feat["id"])
            if steps:
                after.append(f"journey {j['name']!r} keeps its {steps} step(s), no longer linked to it")
        head = f"feature {feat['name']!r}" + (f" (cascades {_and(parts)})" if parts else "")
        return "; ".join([head, *after]), {"guesses": guesses}

    def remove_features(self):
        for feat in self.feats.values():
            label, cascades = self._feature_line(feat)
            self.remove("features", f"/api/features/{feat['id']}", label, cascades=cascades)

    def remove_technologies(self):
        """Deletable technologies go, with their links to capabilities, each
        named. On a kept one, the seed's confirmed satisfactions of a
        capability that is about to be deleted go first: the capability
        foreign key restricts, and the seed is what created them."""
        cap_names = {c["id"]: c["name"] for c in self.inst_caps}
        tech_names = {t["id"]: t["name"] for t in self.inst_techs}

        def names(rows):
            return _and([repr(cap_names.get(r["capability_id"], r["capability_id"])) for r in rows])

        for tech in self._dead_cache_rows("techs"):
            sats = [s for s in self.inst_sats if s["tech_id"] == tech["id"]]
            guesses = [g for g in self.inst_guesses if g.get("tech_id") == tech["id"]]
            parts = ([f"its satisfaction(s) of {names(sats)}"] if sats else []) + (
                [f"its guess(es) about {names(guesses)}"] if guesses else []
            )
            # A cost someone scored on a link: no seed file carries one.
            costed = [s for s in sats if s.get("cost")]
            lost = (
                "; importing this file again won't bring back the cost recorded on its "
                f"satisfaction(s) of {names(costed)}" if costed else ""
            )
            self.remove(
                "technologies",
                f"/api/tech/{urllib.parse.quote(tech['slug'], safe='')}",
                f"technology {tech['name']!r}" + (f" (cascades {_and(parts)})" if parts else "") + lost,
                unsure=True,
                cascades={"satisfactions": len(sats), "guesses": len(guesses)},
            )
        dead_techs, dead_caps = self._dead("techs"), self._dead("caps")
        for s in self.inst_sats:
            pair = (s["tech_id"], s["capability_id"])
            if s["tech_id"] in dead_techs or pair not in self.declared:
                continue
            label = f"{tech_names.get(s['tech_id'])!r} satisfies {cap_names.get(s['capability_id'])!r}"
            if s["capability_id"] not in dead_caps:
                self.keep("satisfactions", label, ["the technology and the capability both stay"])
                continue
            lost = "; importing this file again won't bring back its recorded cost" if s.get("cost") else ""
            self.remove("satisfactions", f"/api/tech/satisfactions/{s['id']}", label + lost, unsure=True)

    def _dead_cache_rows(self, kind):
        self._dead(kind)
        return self._dead_cache[kind]

    def remove_capabilities(self):
        """A seed technology that stays keeps the guesses the seed made for
        it, except one about a capability that goes: that guess goes with it."""
        dead_techs = self._dead("techs")
        self._dead("caps")
        tech_names = {t["id"]: t["name"] for t in self.inst_techs}
        for cap in self._dead_cache["caps"]:
            guesses = [
                g for g in self.inst_guesses
                if g["capability_id"] == cap["id"] and g.get("tech_id") and g["tech_id"] not in dead_techs
            ]
            who = _and([repr(tech_names.get(g["tech_id"])) for g in guesses])
            self.remove(
                "capabilities",
                f"/api/capabilities/{cap['id']}",
                f"capability {cap['name']!r}" + (f" (cascades the guess(es) that {who} satisfy it)" if guesses else ""),
                unsure=True,
                cascades={"guesses": len(guesses)},
            )

    def numbers_note(self):
        """Display numbers come from a sequence, so a re-import cannot restore them."""
        if any(action in ("would delete", "deleted") for _, action in self.counts):
            self._dead("goals")
            goals = [g for g in self._dead_cache["goals"] if g.get("display_id")]
            example = f" ({goals[-1]['display_id']} would not come back as {goals[-1]['display_id']})" if goals else ""
            self.notes.insert(
                0, f"Numbers are not kept: importing this file again adds these rows back under new numbers{example}."
            )

    def remove_goals(self):
        self._dead("goals")
        for goal in self._dead_cache["goals"]:
            self.remove("goals", f"/api/goals/{goal['id']}", f"goal {goal['title']!r}")

    def report(self):
        # Every kind the in-app removal counts, in its order (unseed.js).
        order = [
            "motivations", "edges", "features", "products", "bundles", "decompositions",
            "technologies", "tech_usage", "satisfactions", "guesses", "capabilities", "goals",
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
        "person signed in to the app as an editor or admin, so with auth on "
        "remove it in the app instead",
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
    unseeder.numbers_note()

    print(("dry run — nothing deleted" if args.dry_run else "unseed complete") + ":")
    unseeder.report()
    if unseeder.warnings:
        sys.exit(2)


if __name__ == "__main__":
    main()
