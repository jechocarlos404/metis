#!/usr/bin/env python3
"""Seed a running metis instance from a metis-seed JSON file (format v1).

Stdlib only, no dependencies. Idempotent: existing entities are matched (goals
by type+title; capabilities by slug; products by name; features by
(product, name); technologies by slug; edges by src+dst+kind; motivations,
product technologies and satisfactions by pair) and reused rather than
duplicated, so re-running the same file is safe. No entity or confirmed link
is deleted. Two updates: a reused feature gains the file's confirmed capability
links it lacks (never loses one, and the guess on each newly linked pair goes
away) and takes the status, description and unknown_capabilities the file
states, each overwrite listed; and an existing guess takes the file's
confidence and basis.

With auth on, pass a token (--token, or METIS_TOKEN / METIS_API_TOKEN). Any
valid token can run --dry-run; a write needs a person signed in to the app as
an editor or admin, and this script signs no one in, so load the file in the
app instead (Settings, Seed files).

Usage:
    python3 seed_instance.py metis-seed.json [--base-url http://localhost:8000] [--dry-run] [--token TOKEN]
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Validation: keep everything from GOAL_TYPES through validate() identical to
# ../../metis-export/scripts/validate_seed.py
# ---------------------------------------------------------------------------

GOAL_TYPES = {"org", "product"}
WORK_STATUSES = {"pending", "in_progress", "done"}
MATURITIES = {"planned", "alpha", "beta", "ga", "deprecated", "retired"}
EDGE_KINDS = {"DEPENDS_ON", "BLOCKS", "RELATES_TO"}
CONTEXT_BUDGETS = {"S", "M", "L"}
CONFIDENCES = {"low", "medium", "high"}
TECH_KINDS = {"language", "framework", "library", "runtime", "service", "model", "protocol"}
TECH_LAYERS = {"data", "api", "web", "agent", "infra", "ops"}
TECH_FITS = {"native", "partial", "workaround"}


def slugify(value):
    """The backend's slug rule: lowercase kebab, '' when nothing survives."""
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


def tech_slug(tech):
    """A technology's identity: its explicit slug, else one derived from its name."""
    if tech.get("slug") is not None:
        return tech["slug"]
    return slugify(tech["name"]) if isinstance(tech.get("name"), str) else ""


# A capability's identity, the same rule: "Keyword search" is "Keyword Search".
cap_slug = tech_slug


def _check_guess(errors, where, item):
    if item.get("confidence") not in CONFIDENCES:
        errors.append(f"{where}: confidence must be one of {sorted(CONFIDENCES)}")
    if item.get("basis") is not None and not isinstance(item["basis"], str):
        errors.append(f"{where}: basis must be a string")


def _check_priority(errors, where, item):
    p = item.get("priority")
    if p is not None and (not isinstance(p, int) or isinstance(p, bool) or not 1 <= p <= 5):
        errors.append(f"{where}: priority must be an integer 1-5")


def _check_status(errors, where, item):
    s = item.get("status")
    if s is not None and s not in WORK_STATUSES:
        errors.append(f"{where}: status must be one of {sorted(WORK_STATUSES)}")


def _check_facets(errors, where, item):
    facets = item.get("facets")
    if facets is None:
        return
    if not isinstance(facets, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in facets.items()
    ):
        errors.append(f"{where}: facets must be an object of string -> string")


def feature_capability_refs(feature):
    """Every capability ref a feature REALIZES. `capability_refs` (list) is
    current; a legacy single `capability_ref` reads as a one-element list."""
    refs = feature.get("capability_refs")
    if refs is None and feature.get("capability_ref") is not None:
        refs = [feature["capability_ref"]]
    if refs is None and feature.get("unknown_capabilities") is True:
        refs = []  # declared unknown: none named yet
    return refs


def validate(doc):
    """Return a list of error strings; empty means the document is loadable."""
    errors = []

    if doc.get("format") != "metis-seed/v1":
        errors.append("'format' must be \"metis-seed/v1\"")

    def check_refs(collection):
        refs = set()
        for i, item in enumerate(doc.get(collection) or []):
            ref = item.get("ref")
            if not isinstance(ref, str) or not ref:
                errors.append(f"{collection}[{i}]: missing or non-string 'ref'")
            elif ref in refs:
                errors.append(f"{collection}: duplicate ref {ref!r}")
            else:
                refs.add(ref)
        return refs

    goal_refs = check_refs("goals")
    cap_refs = check_refs("capabilities")
    feat_refs = check_refs("features")
    prod_refs = check_refs("products")

    def check_parent_forest(collection, refs):
        parents = {}
        for item in doc.get(collection) or []:
            ref, parent = item.get("ref"), item.get("parent_ref")
            if parent is not None:
                if parent not in refs:
                    errors.append(f"{collection} {ref!r}: unknown parent_ref {parent!r}")
                elif parent == ref:
                    errors.append(f"{collection} {ref!r}: is its own parent")
                else:
                    parents[ref] = parent
        for start in parents:
            seen, node = set(), start
            while node in parents:
                if node in seen:
                    errors.append(f"{collection}: parent cycle involving {node!r}")
                    break
                seen.add(node)
                node = parents[node]

    check_parent_forest("goals", goal_refs)
    check_parent_forest("capabilities", cap_refs)

    for i, g in enumerate(doc.get("goals") or []):
        where = f"goals[{i}] ({g.get('ref')})"
        if g.get("goal_type") not in GOAL_TYPES:
            errors.append(f"{where}: goal_type must be one of {sorted(GOAL_TYPES)}")
        if not g.get("title"):
            errors.append(f"{where}: 'title' is required")
        _check_priority(errors, where, g)
        _check_status(errors, where, g)

    seen_cap_slugs = set()
    for i, c in enumerate(doc.get("capabilities") or []):
        where = f"capabilities[{i}] ({c.get('ref')})"
        if not c.get("name"):
            errors.append(f"{where}: 'name' is required")
        slug = cap_slug(c)
        if not isinstance(slug, str) or not slug:
            errors.append(f"{where}: slug must be a non-empty string "
                          "(give one when the name yields none)")
        elif slug in seen_cap_slugs:
            errors.append(f"{where}: duplicate capability slug {slug!r}")
        else:
            seen_cap_slugs.add(slug)
        if c.get("maturity") is not None and c["maturity"] not in MATURITIES:
            errors.append(f"{where}: maturity must be one of {sorted(MATURITIES)}")
        _check_facets(errors, where, c)
        anchors = c.get("evidence_anchors")
        if anchors is not None and (
            not isinstance(anchors, list) or any(not isinstance(a, str) for a in anchors)
        ):
            errors.append(f"{where}: evidence_anchors must be a list of strings")

    seen_pairs = set()
    for i, m in enumerate(doc.get("motivations") or []):
        where = f"motivations[{i}]"
        if m.get("goal_ref") not in goal_refs:
            errors.append(f"{where}: unknown goal_ref {m.get('goal_ref')!r}")
        if m.get("capability_ref") not in cap_refs:
            errors.append(f"{where}: unknown capability_ref {m.get('capability_ref')!r}")
        pair = (m.get("goal_ref"), m.get("capability_ref"))
        if pair in seen_pairs:
            errors.append(f"{where}: duplicate motivation {pair}")
        seen_pairs.add(pair)

    for i, f in enumerate(doc.get("features") or []):
        where = f"features[{i}] ({f.get('ref')})"
        if not f.get("name"):
            errors.append(f"{where}: 'name' is required")
        refs = feature_capability_refs(f)
        unknown = f.get("unknown_capabilities", False)
        if not isinstance(unknown, bool):
            errors.append(f"{where}: unknown_capabilities must be true or false")
        if not isinstance(refs, list) or (not refs and unknown is not True):
            errors.append(f"{where}: capability_refs must be a non-empty list of capability refs "
                          "(or set unknown_capabilities: true)")
        else:
            for ref in refs:
                if ref not in cap_refs:
                    errors.append(f"{where}: capability ref {ref!r} does not match a capability")
            if len(set(map(str, refs))) != len(refs):
                errors.append(f"{where}: capability_refs lists a capability twice")
        guesses = f.get("capability_guesses")
        if guesses is not None and not isinstance(guesses, list):
            errors.append(f"{where}: capability_guesses must be a list")
        elif guesses:
            confirmed = set(map(str, refs)) if isinstance(refs, list) else set()
            guessed = set()
            for j, g in enumerate(guesses):
                gwhere = f"{where}.capability_guesses[{j}]"
                if not isinstance(g, dict):
                    errors.append(f"{gwhere}: must be an object")
                    continue
                ref = g.get("capability_ref")
                if not isinstance(ref, str) or ref not in cap_refs:
                    errors.append(f"{gwhere}: capability_ref {ref!r} does not match a capability")
                elif ref in confirmed:
                    errors.append(f"{gwhere}: {ref!r} is also in capability_refs "
                                  "(a link is confirmed or guessed, not both)")
                elif ref in guessed:
                    errors.append(f"{gwhere}: {ref!r} is guessed twice")
                guessed.add(ref)
                _check_guess(errors, gwhere, g)
        if f.get("product_ref") is not None and f["product_ref"] not in prod_refs:
            errors.append(f"{where}: unknown product_ref {f['product_ref']!r}")
        _check_priority(errors, where, f)
        _check_status(errors, where, f)
        _check_facets(errors, where, f)

    check_refs("technologies")
    seen_slugs = set()
    for i, t in enumerate(doc.get("technologies") or []):
        where = f"technologies[{i}] ({t.get('ref')})"
        if not isinstance(t.get("name"), str) or not t["name"]:
            errors.append(f"{where}: 'name' is required")
        slug = tech_slug(t)
        if not isinstance(slug, str) or not slug:
            errors.append(f"{where}: slug must be a non-empty string "
                          "(give one when the name yields none)")
        elif slug in seen_slugs:
            errors.append(f"{where}: duplicate technology slug {slug!r}")
        else:
            seen_slugs.add(slug)
        if t.get("kind") not in TECH_KINDS:
            errors.append(f"{where}: kind must be one of {sorted(TECH_KINDS)}")
        if t.get("layer") is not None and t["layer"] not in TECH_LAYERS:
            errors.append(f"{where}: layer must be one of {sorted(TECH_LAYERS)}")
        products = t.get("products")
        if products is not None and (
            not isinstance(products, list)
            or any(not isinstance(ref, str) or ref not in prod_refs for ref in products)
        ):
            errors.append(f"{where}: products must be product refs")
        satisfies = t.get("satisfies")
        if satisfies is not None and not isinstance(satisfies, list):
            errors.append(f"{where}: satisfies must be a list")
            continue
        linked = set()
        for j, s in enumerate(satisfies or []):
            swhere = f"{where}.satisfies[{j}]"
            if not isinstance(s, dict):
                errors.append(f"{swhere}: must be an object")
                continue
            ref = s.get("capability_ref")
            if not isinstance(ref, str) or ref not in cap_refs:
                errors.append(f"{swhere}: capability_ref {ref!r} does not match a capability")
            elif ref in linked:
                errors.append(f"{swhere}: {ref!r} is listed twice")
            linked.add(ref)
            if s.get("confidence") is None:  # confirmed: observed in code
                if s.get("fit") not in TECH_FITS:
                    errors.append(f"{swhere}: fit must be one of {sorted(TECH_FITS)}")
                if s.get("basis") is not None and not isinstance(s["basis"], str):
                    errors.append(f"{swhere}: basis must be a string")
            else:  # a guess
                _check_guess(errors, swhere, s)
                if s.get("fit") is not None and s["fit"] not in TECH_FITS:
                    errors.append(f"{swhere}: fit must be one of {sorted(TECH_FITS)}")

    seen_edges = set()
    precedence = {}  # feature ref -> set of feature refs it depends on
    for i, e in enumerate(doc.get("edges") or []):
        where = f"edges[{i}]"
        src, dst = e.get("src_ref"), e.get("dst_ref")
        kind = e.get("kind", "DEPENDS_ON")
        if src not in feat_refs:
            errors.append(f"{where}: unknown src_ref {src!r}")
            continue
        if dst not in feat_refs:
            errors.append(f"{where}: unknown dst_ref {dst!r}")
            continue
        if kind not in EDGE_KINDS:
            errors.append(f"{where}: kind must be one of {sorted(EDGE_KINDS)}")
            continue
        if src == dst:
            errors.append(f"{where}: self-loop on {src!r}")
            continue
        key = (src, dst, kind)
        if key in seen_edges:
            errors.append(f"{where}: duplicate edge {key}")
        seen_edges.add(key)
        if kind == "DEPENDS_ON":
            precedence.setdefault(src, set()).add(dst)
        elif kind == "BLOCKS":
            precedence.setdefault(dst, set()).add(src)

    # The precedence graph (DEPENDS_ON plus reversed BLOCKS) must be acyclic —
    # metis rejects cycle-closing edges at write time, so catch it here.
    state, cycle_found = {}, []

    def dfs(node, path):
        state[node] = "in"
        path.append(node)
        for nxt in sorted(precedence.get(node, ())):
            if cycle_found:
                return
            if state.get(nxt) == "in":
                cycle = path[path.index(nxt):] + [nxt]
                errors.append("edges: precedence cycle: " + " -> ".join(cycle))
                cycle_found.append(True)
                return
            if state.get(nxt) is None:
                dfs(nxt, path)
        path.pop()
        state[node] = "done"

    for ref in sorted(precedence):
        if state.get(ref) is None and not cycle_found:
            dfs(ref, [])

    for i, p in enumerate(doc.get("products") or []):
        where = f"products[{i}] ({p.get('ref')})"
        if not p.get("name"):
            errors.append(f"{where}: 'name' is required")
        if p.get("goal_ref") is not None and p["goal_ref"] not in goal_refs:
            errors.append(f"{where}: unknown goal_ref {p['goal_ref']!r}")
        if not isinstance(p.get("external", False), bool):
            errors.append(f"{where}: external must be true or false")
        bundle_refs = p.get("bundle_refs")
        if bundle_refs is not None and (
            not isinstance(bundle_refs, list)
            or any(not isinstance(ref, str) or ref not in cap_refs for ref in bundle_refs)
        ):
            errors.append(f"{where}: bundle_refs must be capability refs")
        decomp = p.get("decomposition")
        if decomp is None:
            continue
        for j, epic in enumerate(decomp.get("epics") or []):
            ewhere = f"{where}.epics[{j}]"
            if not epic.get("title"):
                errors.append(f"{ewhere}: 'title' is required")
            if epic.get("capability_ref") is not None and epic["capability_ref"] not in cap_refs:
                errors.append(f"{ewhere}: unknown capability_ref {epic['capability_ref']!r}")
            for k, story in enumerate(epic.get("stories") or []):
                swhere = f"{ewhere}.stories[{k}]"
                if not story.get("title"):
                    errors.append(f"{swhere}: 'title' is required")
                if story.get("feature_ref") is not None and story["feature_ref"] not in feat_refs:
                    errors.append(f"{swhere}: unknown feature_ref {story['feature_ref']!r}")
                for t, ticket in enumerate(story.get("tickets") or []):
                    twhere = f"{swhere}.tickets[{t}]"
                    if not ticket.get("title"):
                        errors.append(f"{twhere}: 'title' is required")
                    cb = ticket.get("context_budget")
                    if cb is not None and cb not in CONTEXT_BUDGETS:
                        errors.append(
                            f"{twhere}: context_budget must be one of {sorted(CONTEXT_BUDGETS)}"
                        )
                    files = ticket.get("affected_files")
                    if files is not None and (
                        not isinstance(files, list) or any(not isinstance(a, str) for a in files)
                    ):
                        errors.append(f"{twhere}: affected_files must be a list of strings")

    return errors


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

DRY_PREFIX = "dry-run:"


def prune(payload):
    return {k: v for k, v in payload.items() if v is not None}


def parents_first(items):
    """Yield items so every parent_ref is yielded before its children."""
    done, remaining = set(), list(items)
    while remaining:
        progressed = False
        for item in list(remaining):
            parent = item.get("parent_ref")
            if parent is None or parent in done:
                done.add(item["ref"])
                remaining.remove(item)
                progressed = True
                yield item
        if not progressed:  # unreachable after validation; guard against hangs
            raise RuntimeError("unresolvable parent_ref ordering")


def quoted(value):
    """A name in a report line, quoted the way the in-app importer quotes it."""
    return json.dumps(value, ensure_ascii=False)


def text_change(before, after, limit=60):
    """Two versions of a text, trimmed to show where they differ, the way the
    in-app importer shows them: '"Plans." → "Plans in phases."'."""
    a = " ".join(str(before or "").split())
    b = " ".join(str(after or "").split())
    same = 0
    while same < len(a) and same < len(b) and a[same] == b[same]:
        same += 1
    start = a.rfind(" ", 0, same - 19) + 1 if same > 30 else 0

    def cut(text):
        if not text:
            return "empty"
        rest = text[start:]
        if len(rest) > limit:
            rest = rest[: limit - 1] + "…"
        return quoted(("…" if start > 0 else "") + rest)

    return f"{cut(a)} → {cut(b)}"


def capability_resolver(instance):
    """Find the instance capability a seed capability names. A slug match wins:
    the explicit slug, then the one its name derives. A rename keeps the old
    slug, so last the derived slug is matched against each row's current name,
    preferring the row with exactly that name."""
    by_slug = {c["slug"]: c for c in instance}
    by_name = {}
    for c in instance:
        by_name.setdefault(slugify(c["name"]), []).append(c)

    def resolve(cap):
        if cap.get("slug") is not None and cap["slug"] in by_slug:
            return by_slug[cap["slug"]]
        derived = slugify(cap["name"])
        if derived in by_slug:
            return by_slug[derived]
        rows = by_name.get(derived) or []
        return next((r for r in rows if r["name"] == cap["name"]), rows[0] if rows else None)

    return resolve


IN_APP = (
    "Writes need a person signed in to the app as an editor or admin, and this "
    "script signs no one in. An editor or admin can load the file in the app "
    "(Settings, Seed files: check, then import), or run this against an "
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
            sys.exit(f"error: {method} {path} returned 403: this token can read but not write. {IN_APP}")
        # The role refusal: a viewer can't write in the app either.
        sys.exit(
            f"error: {method} {path} returned 403 ({detail}): this account can't write, "
            "from a script or in the app; an editor or admin can. Ask one to load the "
            "file in the app (Settings, Seed files: check, then import)."
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
        """For endpoints an older instance may not have yet: absent reads as []."""
        status, body = self.request("GET", path)
        return body if status == 200 else []

    def post(self, path, payload):
        return self.request("POST", path, payload)

    def put(self, path, payload):
        return self.request("PUT", path, payload)

    def patch(self, path, payload):
        return self.request("PATCH", path, payload)


class Loader:
    def __init__(self, api, doc, dry_run):
        self.api = api
        self.doc = doc
        self.dry_run = dry_run
        self.counts = {}  # (collection, action) -> int
        self.notes = []  # expected skips (idempotent re-runs) — informational
        self.warnings = []  # seed content that could not be applied — exit 2
        self.goal_ids = {}
        self.cap_ids = {}
        self.feat_ids = {}
        self.prod_ids = {}
        self.tech_ids = {}
        self.feat_caps = {}  # feature ref -> capability ids it realizes (confirmed)
        self._guesses = None

    def note(self, collection, action):
        self.counts[(collection, action)] = self.counts.get((collection, action), 0) + 1

    def create(self, collection, path, payload, label):
        if self.dry_run:
            self.note(collection, "would create")
            return f"{DRY_PREFIX}{collection}:{label}"
        status, body = self.api.post(path, prune(payload))
        if status != 201:
            sys.exit(f"error: POST {path} for {label!r} returned {status}: {body}")
        self.note(collection, "created")
        return body["id"]

    def load_goals(self):
        existing = {(g["goal_type"], g["title"]): g["id"] for g in self.api.get("/api/goals")}
        for g in parents_first(self.doc.get("goals") or []):
            key = (g["goal_type"], g["title"])
            if key in existing:
                self.goal_ids[g["ref"]] = existing[key]
                self.note("goals", "reused")
                continue
            self.goal_ids[g["ref"]] = self.create(
                "goals",
                "/api/goals",
                {
                    "goal_type": g["goal_type"],
                    "parent_goal_id": self.goal_ids.get(g.get("parent_ref")),
                    "title": g["title"],
                    "description": g.get("description"),
                    "success_criteria": g.get("success_criteria"),
                    "priority": g.get("priority"),
                    "status": g.get("status"),
                },
                g["title"],
            )

    def load_capabilities(self):
        resolve = capability_resolver(self.api.get("/api/capabilities"))
        added = []
        for c in parents_first(self.doc.get("capabilities") or []):
            found = resolve(c)
            if found:
                self.reuse_capability(c, found)
                continue
            payload = {
                "parent_id": self.cap_ids.get(c.get("parent_ref")),
                "slug": c.get("slug"),
                "name": c["name"],
                "description": c.get("description"),
                "maturity": c.get("maturity"),
                "facets": c.get("facets"),
                "evidence_anchors": c.get("evidence_anchors"),
            }
            if self.dry_run:
                self.cap_ids[c["ref"]] = self.create("capabilities", "/api/capabilities", payload, c["name"])
                added.append(c["name"])
                continue
            status, body = self.api.post("/api/capabilities", prune(payload))
            # The clash names the row under `existing`; an older instance put
            # it in `detail` itself.
            existing = body.get("existing") or body.get("detail") if isinstance(body, dict) else None
            if status == 201:
                self.cap_ids[c["ref"]] = body["id"]
                self.note("capabilities", "created")
                added.append(c["name"])
            elif status == 409 and isinstance(existing, dict) and isinstance(existing.get("slug"), str):
                # Created since the list was read: the same slug is the same capability.
                row = next(
                    (r for r in self.api.get("/api/capabilities") if r["slug"] == existing["slug"]), None
                )
                if row is None:
                    sys.exit(f"error: POST /api/capabilities for {c['name']!r} returned 409 "
                             f"for a slug no capability has: {body}")
                self.reuse_capability(c, row)
            else:
                sys.exit(f"error: POST /api/capabilities for {c['name']!r} returned {status}: {body}")
        self.list_added_capabilities(added)

    def reuse_capability(self, c, row):
        self.cap_ids[c["ref"]] = row["id"]
        self.note("capabilities", "reused")
        if row["name"] != c["name"]:
            self.notes.append(
                f"capability {quoted(c['name'])} is the existing {quoted(row['name'])} "
                f"(slug {row['slug']}); reused as it is"
            )

    def list_added_capabilities(self, names):
        """Every capability the file adds, by name; in a dry run with the
        closest existing names, so a near-duplicate is caught before loading."""
        if not names:
            return
        nearest = {}
        if self.dry_run:
            status, body = self.api.post(
                "/api/capabilities/coverage",
                {"features": [{"name": "seed file", "capabilities": names}]},
            )
            if status == 200:
                needs = (body.get("features") or [{}])[0].get("capabilities") or []
                nearest = {n["name"]: [c["name"] for c in n.get("candidates") or []] for n in needs}
        for name in names:
            near = nearest.get(name.strip()) or []
            self.notes.append(
                f"new capability {quoted(name)}"
                + (f"; nearest existing: {', '.join(quoted(n) for n in near)}" if near else "")
            )

    def load_motivations(self):
        by_cap = {}
        for m in self.doc.get("motivations") or []:
            by_cap.setdefault(m["capability_ref"], []).append(m["goal_ref"])
        for cap_ref, goal_refs in sorted(by_cap.items()):
            cap_id = self.cap_ids[cap_ref]
            existing = set()
            if not str(cap_id).startswith(DRY_PREFIX):
                existing = {
                    g["id"] for g in self.api.get(f"/api/capabilities/{cap_id}/motivations")
                }
            for goal_ref in goal_refs:
                goal_id = self.goal_ids[goal_ref]
                if goal_id in existing:
                    self.note("motivations", "reused")
                elif self.dry_run:
                    self.note("motivations", "would create")
                else:
                    status, body = self.api.post(
                        f"/api/capabilities/{cap_id}/motivations", {"goal_id": goal_id}
                    )
                    if status != 201:
                        sys.exit(
                            f"error: motivation {goal_ref} -> {cap_ref} "
                            f"returned {status}: {body}"
                        )
                    self.note("motivations", "created")

    def update_reused_feature(self, f, current):
        """A reused feature gains the file's confirmed links it lacks, never
        losing one. A product's own seed is the authority on its own features,
        so the status, description and unknown_capabilities the file states
        replace the feature's; a field the file leaves out is left alone. Each
        overwrite is listed by feature, in a dry run too, since it may undo a
        hand edit. Returns the feature's confirmed links afterwards."""
        have = list(current.get("capability_ids") or [])
        missing = [
            cid
            for cid in dict.fromkeys(self.cap_ids[r] for r in feature_capability_refs(f))
            if cid not in have
        ]
        payload = {}
        changes = []
        if missing:
            payload["capability_ids"] = have + missing
        if f.get("status") is not None and f["status"] != current.get("status"):
            payload["status"] = f["status"]
            changes.append(f"status {current.get('status')} → {f['status']}")
        if f.get("description") is not None and f["description"] != current.get("description"):
            payload["description"] = f["description"]
            changes.append(f"description {text_change(current.get('description'), f['description'])}")
        flag = f.get("unknown_capabilities")
        if flag is not None and flag != (current.get("unknown_capabilities") is True):
            payload["unknown_capabilities"] = flag
            changes.append(f"unknown_capabilities {str(not flag).lower()} → {str(flag).lower()}")
        if not payload:
            return set(have)
        overwrites = f"feature {quoted(f['name'])}: {'; '.join(changes)}" if changes else None
        if self.dry_run:
            self.note("features", "would link" if missing else "would update")
            if overwrites:
                self.notes.append(overwrites)
            return set(have + missing)
        status, body = self.api.patch(f"/api/features/{current['id']}", payload)
        if status != 200:
            self.warnings.append(f"feature {f['ref']} rejected ({status}): {body}")
            self.note("features", "rejected")
            return set(have)
        self.note("features", "linked" if missing else "updated")
        if overwrites:
            self.notes.append(overwrites)
        return set(body["capability_ids"])

    def load_features(self):
        # On reuse, links only grow and the file's stated status, description
        # and unknown_capabilities win (update_reused_feature). Identity is
        # (product, name): features belong to their product, so another
        # product's "Sign in" is a different feature, not a reuse.
        instance = self.api.get("/api/features")
        existing = {(f.get("product_id"), f["name"]): f for f in instance}
        for f in self.doc.get("features") or []:
            key = (self.prod_ids.get(f.get("product_ref")), f["name"])
            if key in existing:
                self.feat_ids[f["ref"]] = existing[key]["id"]
                self.note("features", "reused")
                self.feat_caps[f["ref"]] = self.update_reused_feature(f, existing[key])
                continue
            self.feat_caps[f["ref"]] = {self.cap_ids[r] for r in feature_capability_refs(f)}
            self.feat_ids[f["ref"]] = self.create(
                "features",
                "/api/features",
                {
                    "capability_ids": [self.cap_ids[r] for r in feature_capability_refs(f)],
                    "unknown_capabilities": f.get("unknown_capabilities") is True,
                    "product_id": self.prod_ids.get(f.get("product_ref")),
                    "name": f["name"],
                    "description": f.get("description"),
                    "facets": f.get("facets"),
                    "status": f.get("status"),
                    "priority": f.get("priority"),
                    "priority_rationale": f.get("priority_rationale"),
                },
                f["name"],
            )

    def guesses(self):
        """Guesses already in the instance, keyed by their (capability, feature
        or tech) pair. An instance without the guesses endpoint has none."""
        if self._guesses is None:
            status, body = self.api.request("GET", "/api/guesses")
            if status == 403:
                self.notes.append(
                    "this token cannot read guesses (editors and admins only), "
                    "so guess counts assume none exist yet"
                )
            self._guesses = {
                (g["capability_id"], g.get("feature_id") or g.get("tech_id")): g
                for g in (body if status == 200 else [])
            }
        return self._guesses

    def post_guess(self, payload, label):
        """Create or update one guess. The endpoint is idempotent per pair, so
        a re-import updates confidence and basis instead of stacking rows."""
        other = payload.get("feature_id") or payload.get("tech_id")
        current = self.guesses().get((payload["capability_id"], other))
        exists = current is not None
        if exists and all(current.get(k) == payload.get(k) for k in ("confidence", "basis", "fit")):
            self.note("guesses", "reused")
            return
        if self.dry_run or str(other).startswith(DRY_PREFIX):
            self.note("guesses", "would update" if exists else "would create")
            return
        status, body = self.api.post("/api/guesses", prune(payload))
        if status in (200, 201):
            self.note("guesses", "updated" if exists else "created")
        else:
            self.warnings.append(f"guess {label} rejected ({status}): {body}")
            self.note("guesses", "rejected")

    def load_feature_guesses(self):
        # Reused features get their guesses too: guesses arrive gradually, on
        # each product's next export, mostly for features metis already has.
        for f in self.doc.get("features") or []:
            fid = self.feat_ids[f["ref"]]
            for g in f.get("capability_guesses") or []:
                cap_id = self.cap_ids[g["capability_ref"]]
                label = f"{f['ref']} ~> {g['capability_ref']}"
                if cap_id in self.feat_caps.get(f["ref"], set()):
                    self.notes.append(f"guess {label} skipped: the link is already confirmed")
                    self.note("guesses", "skipped")
                    continue
                self.post_guess(
                    {
                        "capability_id": cap_id,
                        "feature_id": fid,
                        "confidence": g["confidence"],
                        "basis": g.get("basis"),
                    },
                    label,
                )

    def all_technologies(self):
        rows, offset = [], 0
        while True:
            page = self.api.get(f"/api/tech?limit=200&offset={offset}")
            rows.extend(page["rows"])
            offset += 200
            if offset >= page["total"] or not page["rows"]:
                return rows

    def load_technologies(self):
        techs = self.doc.get("technologies") or []
        if not techs:
            return
        existing = {t["slug"]: t["id"] for t in self.all_technologies()}
        for t in techs:
            slug = tech_slug(t)
            if slug in existing:
                self.tech_ids[t["ref"]] = existing[slug]
                self.note("technologies", "reused")
                continue
            self.tech_ids[t["ref"]] = self.create(
                "technologies",
                "/api/tech",
                {"slug": slug, "name": t["name"], "kind": t["kind"], "layer": t.get("layer")},
                t["name"],
            )

        # Observed usage. PUT resets an existing row's slot binding, so pairs
        # already recorded are left alone.
        usage = {}
        for t in techs:
            tid = self.tech_ids[t["ref"]]
            for prod_ref in t.get("products") or []:
                pid = self.prod_ids[prod_ref]
                if str(pid).startswith(DRY_PREFIX) or str(tid).startswith(DRY_PREFIX):
                    self.note("tech_usage", "would create")
                    continue
                if pid not in usage:
                    usage[pid] = {
                        u["tech_id"] for u in self.api.get(f"/api/stacks/usage?product_id={pid}")
                    }
                if tid in usage[pid]:
                    self.note("tech_usage", "reused")
                elif self.dry_run:
                    self.note("tech_usage", "would create")
                else:
                    status, body = self.api.put(
                        f"/api/stacks/usage?product_id={pid}", {"tech_id": tid}
                    )
                    if status not in (200, 201):
                        sys.exit(f"error: usage {t['ref']} by {prod_ref} returned {status}: {body}")
                    usage[pid].add(tid)
                    self.note("tech_usage", "created")

        # Removing a product leaves a person's recorded use of a technology
        # with no product, and an import never links one back: say so, so a
        # re-import isn't read as a full restore.
        for t in techs:
            slug = tech_slug(t)
            if slug not in existing or not t.get("products"):
                continue
            detail = self.api.get_optional(f"/api/tech/{urllib.parse.quote(slug, safe='')}")
            people = [e["person"] for e in (detail.get("encounters") or []) if not e.get("product_id")] \
                if isinstance(detail, dict) else []
            if people:
                self.notes.append(
                    f"technology {t['name']!r} has {len(people)} recorded use(s) naming no product "
                    f"({', '.join(people)}); an import never links a recorded use to a product"
                )

        confirmed = {
            (s["tech_id"], s["capability_id"]) for s in self.api.get("/api/tech/satisfactions")
        }
        for t in techs:
            tid = self.tech_ids[t["ref"]]
            for s in t.get("satisfies") or []:
                cap_id = self.cap_ids[s["capability_ref"]]
                label = f"{t['ref']} satisfies {s['capability_ref']}"
                if s.get("confidence") is not None:
                    if (tid, cap_id) in confirmed:
                        self.notes.append(f"guess {label} skipped: the link is already confirmed")
                        self.note("guesses", "skipped")
                        continue
                    self.post_guess(
                        {
                            "capability_id": cap_id,
                            "tech_id": tid,
                            "confidence": s["confidence"],
                            "basis": s.get("basis"),
                            "fit": s.get("fit"),
                        },
                        label,
                    )
                    continue
                if (tid, cap_id) in confirmed:
                    self.note("satisfactions", "reused")
                    continue
                if self.dry_run:
                    self.note("satisfactions", "would create")
                    continue
                status, body = self.api.post(
                    "/api/tech/satisfactions",
                    prune(
                        {
                            "tech_id": tid,
                            "capability_id": cap_id,
                            "fit": s["fit"],
                            "notes": s.get("basis"),
                        }
                    ),
                )
                if status == 201:
                    self.note("satisfactions", "created")
                elif status == 409:
                    self.note("satisfactions", "reused")
                else:
                    sys.exit(f"error: satisfaction {label} returned {status}: {body}")

    def load_edges(self):
        existing = {
            (e["src_id"], e["dst_id"], e["kind"]) for e in self.api.get("/api/features/edges")
        }
        for e in self.doc.get("edges") or []:
            kind = e.get("kind", "DEPENDS_ON")
            src, dst = self.feat_ids[e["src_ref"]], self.feat_ids[e["dst_ref"]]
            label = f"{e['src_ref']} -{kind}-> {e['dst_ref']}"
            if (src, dst, kind) in existing:
                self.note("edges", "reused")
                continue
            if self.dry_run:
                self.note("edges", "would create")
                continue
            status, body = self.api.post(
                "/api/features/edges", {"src_id": src, "dst_id": dst, "kind": kind}
            )
            if status == 201:
                self.note("edges", "created")
            else:
                # Most likely a cycle-closing precedence edge, rejected by the
                # API against edges already in the instance. Skip and report.
                self.warnings.append(f"edge {label} rejected ({status}): {body}")
                self.note("edges", "rejected")

    def load_product_rows(self):
        """Products before features: a feature's product_ref needs the id."""
        existing = {p["name"]: p["id"] for p in self.api.get("/api/products")}
        for p in self.doc.get("products") or []:
            pid = existing.get(p["name"])
            if pid is not None:
                self.note("products", "reused")
            else:
                pid = self.create(
                    "products",
                    "/api/products",
                    {
                        "goal_id": self.goal_ids.get(p.get("goal_ref")),
                        "name": p["name"],
                        "summary": p.get("summary"),
                        "body": p.get("body"),
                        "external": bool(p.get("external", False)),
                    },
                    p["name"],
                )
            self.prod_ids[p["ref"]] = pid

    def load_products(self):
        """Bundles and PRDs, once features exist for stories to pin."""
        for p in self.doc.get("products") or []:
            pid = self.prod_ids[p["ref"]]
            existing_bundles = []
            if not str(pid).startswith(DRY_PREFIX):
                existing_bundles = self.api.get(f"/api/products/{pid}/bundles")
            for cap_ref in p.get("bundle_refs") or []:
                cap_id = self.cap_ids[cap_ref]
                if any(c["id"] == cap_id for c in existing_bundles):
                    self.note("bundles", "reused")
                elif self.dry_run:
                    self.note("bundles", "would create")
                else:
                    status, body = self.api.post(
                        f"/api/products/{pid}/bundles", {"capability_id": cap_id}
                    )
                    if status != 201:
                        sys.exit(
                            f"error: bundle {cap_ref!r} for {p['name']!r} "
                            f"returned {status}: {body}"
                        )
                    self.note("bundles", "created")
            decomp = p.get("decomposition")
            if decomp is None:
                continue
            if str(pid).startswith(DRY_PREFIX):
                self.note("decompositions", "would create")
                continue
            if self.api.get(f"/api/products/{pid}/decompositions"):
                self.notes.append(
                    f"product {p['name']!r} already has a PRD; left as-is "
                    "(the seeder never stacks a second decomposition)"
                )
                self.note("decompositions", "skipped")
                continue
            if self.dry_run:
                self.note("decompositions", "would create")
                continue
            status, body = self.api.post(
                f"/api/products/{pid}/decompositions",
                {"document": self.build_prd(decomp), "created_by": "metis-seed-instance"},
            )
            if status != 201:
                sys.exit(
                    f"error: decomposition for {p['name']!r} returned {status}: {body}"
                )
            self.note("decompositions", "created")

    def mark_seeded(self):
        """Last, once everything loaded: record that each product in the file
        was just refreshed. The server stamps the time."""
        if self.dry_run:
            return
        for pid in dict.fromkeys(self.prod_ids.values()):
            status, body = self.api.post(f"/api/products/{pid}/seeded", None)
            if status != 200:
                self.notes.append(f"could not record when product {pid} was seeded: {status} {body}")

    def build_prd(self, decomp):
        def ticket(t):
            return prune(
                {
                    "title": t["title"],
                    "description": t.get("description"),
                    "technical_approach": t.get("technical_approach"),
                    "acceptance_criteria": t.get("acceptance_criteria"),
                    "affected_files": t.get("affected_files"),
                    "context_budget": t.get("context_budget"),
                }
            )

        def story(s):
            return prune(
                {
                    "title": s["title"],
                    "description": s.get("description"),
                    "feature_id": self.feat_ids.get(s.get("feature_ref")),
                    "tickets": [ticket(t) for t in s.get("tickets") or []],
                }
            )

        def epic(e):
            return prune(
                {
                    "title": e["title"],
                    "acceptance_criteria": e.get("acceptance_criteria"),
                    "capability_id": self.cap_ids.get(e.get("capability_ref")),
                    "stories": [story(s) for s in e.get("stories") or []],
                }
            )

        return prune(
            {
                "summary": decomp.get("summary"),
                "epics": [epic(e) for e in decomp.get("epics") or []],
            }
        )

    def report(self):
        order = [
            "goals",
            "capabilities",
            "motivations",
            "features",
            "edges",
            "products",
            "bundles",
            "decompositions",
            "technologies",
            "tech_usage",
            "satisfactions",
            "guesses",
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
        description="Seed a running metis instance from a metis-seed JSON file."
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
        help="validate and diff against the instance without writing anything",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("METIS_TOKEN") or os.environ.get("METIS_API_TOKEN"),
        help="bearer token for an instance with auth on (default: $METIS_TOKEN, "
        "else $METIS_API_TOKEN). Any valid token can --dry-run; writes need a "
        "person signed in to the app as an editor or admin, so with auth on load "
        "the file in the app instead",
    )
    args = ap.parse_args()

    try:
        with open(args.seed_file) as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit(f"error: cannot read {args.seed_file}: {e}")

    errors = validate(doc)
    if errors:
        print(f"{args.seed_file} failed validation:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    api = Api(args.base_url, args.token)
    status, _ = api.request("GET", "/api/health")
    if status != 200:
        sys.exit(f"error: {args.base_url}/api/health returned {status} — is the instance up?")

    loader = Loader(api, doc, args.dry_run)
    loader.load_goals()
    loader.load_capabilities()
    loader.load_motivations()
    loader.load_product_rows()
    loader.load_features()
    loader.load_feature_guesses()
    loader.load_edges()
    loader.load_technologies()
    loader.load_products()
    loader.mark_seeded()

    print(("dry run — nothing written" if args.dry_run else "seed complete") + ":")
    loader.report()
    if loader.warnings and not args.dry_run:
        sys.exit(2)


if __name__ == "__main__":
    main()
