"""Metis MCP server — read-only, over the same HTTP API the desktop uses.

Two planes, one server. The inventory tools answer the primary question —
"what could we build next, given what already exists?" — for an agent working
for the portfolio owner. The technology tools serve coding agents mid-build
("does this package already have a stance, and what does the group run?").

The technology tools' names **are** the envelope's `question` keys. One
vocabulary across desktop, API and MCP, or the three stop being comparable.
The inventory tools are named for the job and print the API's raw values.

**No mutation tools exist.** `propose_binding` returns a proposal and a link and
persists nothing. That is not a limitation of this file — the token it carries
is issued to `metis-mcp`, and the backend refuses writes from that surface with
a 403 naming the screen that can act.
"""

import json
import re
import uuid

from mcp.server import Server
from mcp.types import (
    CallToolResult,
    GetPromptResult,
    Prompt,
    PromptMessage,
    Resource,
    ResourceTemplate,
    TextContent,
    Tool,
)
from pydantic import AnyUrl

from app.mcp import render
from app.mcp.client import ApiError, MetisClient, SetupError
from app.services.slugs import slugify

server = Server("metis")
client = MetisClient()


def _text(body: str) -> list[TextContent]:
    return [TextContent(type="text", text=body)]


# ---- tools ----

TOOLS = [
    Tool(
        name="tech_search",
        description=(
            "Search the technology catalog. The navigation tool — everything "
            "else takes a slug this returns, so agents never guess slugs."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Substring of name or slug"},
                "kind": {
                    "type": "string",
                    "enum": [
                        "language",
                        "framework",
                        "library",
                        "runtime",
                        "service",
                        "model",
                        "protocol",
                    ],
                },
                "layer": {
                    "type": "string",
                    "enum": ["data", "api", "web", "agent", "infra", "ops"],
                },
                "adoption": {
                    "type": "string",
                    "description": "A stance, or 'none' for no stance taken",
                },
                "limit": {"type": "integer", "default": 20},
            },
        },
    ),
    Tool(
        name="capability_supply",
        description=(
            "What can satisfy this capability, ranked by fit then stance, plus "
            "the features already realizing it. Build and buy in one answer. "
            "The currently-bound technology is marked, never filtered out."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "capability": {"type": "string", "description": "Capability slug"},
                "include_unadopted": {"type": "boolean", "default": True},
            },
            "required": ["capability"],
        },
    ),
    Tool(
        name="tech_blast_radius",
        description=(
            "What breaks if we drop this technology, and what could replace it. "
            "required is a break; optional is an inconvenience; off_stack means the "
            "product's stack never declared it; a product with no stack just uses it."
        ),
        inputSchema={
            "type": "object",
            "properties": {"tech": {"type": "string", "description": "Technology slug"}},
            "required": ["tech"],
        },
    ),
    Tool(
        name="tech_exposure",
        description=(
            "What is dying and whether it matters: a release line expiring, a "
            "stance already given up on, or a bus factor of one. Three "
            "independent modes, no health score."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "window_days": {"type": "integer", "default": 180},
                "product": {"type": "string", "description": "Product slug, optional"},
            },
        },
    ),
    Tool(
        name="stack_redundancy",
        description=(
            "Capabilities a product answers with more than one native or "
            "partial technology. Reported, never resolved."
        ),
        inputSchema={
            "type": "object",
            "properties": {"product": {"type": "string", "description": "Product slug"}},
            "required": ["product"],
        },
    ),
    Tool(
        name="tech_encounters",
        description=(
            "Who here has touched this technology, deepest and most recent "
            "first. Handles only — no skill levels. Rate-limited and logged."
        ),
        inputSchema={
            "type": "object",
            "properties": {"tech": {"type": "string", "description": "Technology slug"}},
            "required": ["tech"],
        },
    ),
    Tool(
        name="stack_recommend",
        description=(
            "What a product's stack should be: ranked bindings with a "
            "rationale, offers pruned with the rule that killed them, and slots "
            "left unresolved rather than guessed at."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "product": {"type": "string", "description": "Product slug"},
                "slot": {"type": "string", "description": "Slot id, optional"},
                "archetype": {"type": "string", "description": "Archetype stack id"},
            },
            "required": ["product"],
        },
    ),
    Tool(
        name="propose_binding",
        description=(
            "Propose binding a technology to a slot. WRITES NOTHING — returns a "
            "proposal and a desktop link. Binding is a human action."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "slot": {"type": "string", "description": "Slot id"},
                "tech": {"type": "string", "description": "Technology slug"},
                "rationale": {"type": "string"},
            },
            "required": ["slot", "tech", "rationale"],
        },
    ),
    # ---- inventory: what exists, and what we could build from it ----
    Tool(
        name="products",
        description=(
            "List products, ours and external, with id, slug, name and "
            "seeded_at (when its seed file was last imported, ISO, or never). The "
            "inventory's navigation tool — the other tools take an id or slug "
            "it returns, so agents never guess."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    Tool(
        name="capability_inventory",
        description=(
            "What we can already do, most reused first: each capability's "
            "slug and exact name, its maturity when ours, our products and "
            "feature count (any status), and external products that have it. "
            "Ours (a finished feature of ours realizes it) first, then external "
            "only, then not built yet (realized by no finished feature)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Substring of name or slug, optional"},
                "limit": {"type": "integer", "default": 50},
            },
        },
    ),
    Tool(
        name="check_idea",
        description=(
            "How much of a product idea we already have. Give features, each "
            "with the capability names it needs. Each need comes back ours, "
            "external only, not built yet (no finished feature realizes it), or "
            "no match with near names as candidates. Exact "
            "names only: a candidate is never counted as a match. Ends with an "
            "Open: link that pre-fills Home's idea check; it saves nothing."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "idea": {
                    "type": "string",
                    "description": "Idea name for the Home link, optional; defaults to the first feature's name",
                },
                "features": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "capabilities": {
                                "type": "array",
                                "minItems": 1,
                                "items": {"type": "string"},
                            },
                        },
                        "required": ["name", "capabilities"],
                    },
                }
            },
            "required": ["features"],
        },
    ),
    Tool(
        name="product_score",
        description=(
            "How much of an external product we could build from what "
            "we have: its features split into four groups that sum to the "
            "total — buildable, partly known, not described, missing a "
            "capability. A lower bound. Then the capabilities we lack, ranked by "
            "how many features each alone would cover, and the three products of "
            "ours that already have the most of what it names. Our own products "
            "are not scored."
        ),
        inputSchema={
            "type": "object",
            "properties": {"product": {"type": "string", "description": "Product id or slug"}},
            "required": ["product"],
        },
    ),
    Tool(
        name="capability",
        description=(
            "One capability by slug or name (a name matches by its slug, as in "
            "check_idea): our products and features that realize it, external "
            "products apart, the goals that motivate it, and its progress rollup."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "slug": {"type": "string", "description": "Capability slug or name"}
            },
            "required": ["slug"],
        },
    ),
    Tool(
        name="feature_why",
        description=(
            "Why a feature exists: the capabilities it realizes, their parents, "
            "and the goals that motivate them, up to org intent. Goals of the "
            "feature's own product come first; the rest are labelled with their "
            "products, and each says which capability it motivates."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "feature": {"type": "string", "description": "Feature id or exact feature name"}
            },
            "required": ["feature"],
        },
    ),
    Tool(
        name="journeys",
        description=(
            "List journeys, or with an id or exact name, one journey's analysis: "
            "each step's verdict (buildable, known_covered, missing, unknown) and "
            "whether a user can do it today."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "journey": {"type": "string", "description": "Journey id or exact name, optional"}
            },
        },
    ),
    Tool(
        name="ready_features",
        description=(
            "Our pending features whose dependencies are all done — what can "
            "start now. Optionally one product."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "product": {"type": "string", "description": "Product id or slug, optional"}
            },
        },
    ),
    Tool(
        name="recheck",
        description=(
            "If a feature changes, what else to recheck: features that break "
            "(depend on it, through links of links), same-product features "
            "sharing a confirmed capability (rarest first), capabilities most "
            "of the product uses (counted), and our other products with the "
            "same capabilities (information only). Guesses are not counted."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "feature": {"type": "string", "description": "Feature id or exact feature name"}
            },
            "required": ["feature"],
        },
    ),
]


@server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


#: The desktop screen of each tool's subject: where an error's Open: line
#: points when the refusal carries no screen of its own.
_SCREENS = {
    "tech_search": "/tech",
    "capability_supply": "/capabilities",
    "tech_blast_radius": "/tech",
    "tech_exposure": "/tech?view=exposure",
    "stack_redundancy": "/stacks",
    "tech_encounters": "/tech",
    "stack_recommend": "/stacks",
    "propose_binding": "/stacks",
    "products": "/products",
    "capability_inventory": "/capabilities",
    "check_idea": "/home",
    "product_score": "/products",
    "capability": "/capabilities",
    "feature_why": "/features",
    "journeys": "/journeys",
    "ready_features": "/features",
    "recheck": "/features",
}


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent] | CallToolResult:
    """An answer, or an error the agent can act on: isError set, one plain
    sentence, and the Open: line every answer ends with."""
    href = _SCREENS.get(name, "/home")
    try:
        return _text(await _dispatch(name, arguments or {}))
    except ApiError as exc:
        hint = None
        if exc.status == 401:
            hint = (
                "This server sent no token (its AUTH_ENABLED is false), and the API "
                "wants one: set AUTH_ENABLED=true for this server as well."
                if not client._settings.auth_enabled
                else "The API refused this server's metis-mcp token."
            )
        text = render.api_error(exc.status, exc.body, href, hint)
    except (BadInput, SetupError) as exc:
        text = render.error(str(exc), href)
    return CallToolResult(content=_text(text), isError=True)


async def _dispatch(name: str, args: dict) -> str:
    if name == "tech_search":
        page = await client.get(
            "/api/tech",
            {
                "q": args.get("q"),
                "kind": args.get("kind"),
                "layer": args.get("layer"),
                "adoption": args.get("adoption"),
                "limit": args.get("limit", 20),
            },
        )
        return render.tech_search(page, args.get("q"))

    if name == "capability_supply":
        # A name matches by its slug, as in check_idea and capability.
        slug = _capability_slug(args["capability"])
        envelope = await client.get(
            f"/api/capabilities/{slug}/supply",
            {"include_unadopted": str(args.get("include_unadopted", True)).lower()},
        )
        stop = _hard_stop(envelope)
        return stop or render.capability_supply(envelope)

    if name == "tech_blast_radius":
        return render.tech_blast_radius(
            await client.get(f"/api/tech/{_safe_slug(args['tech'], 'tech')}/blast-radius")
        )

    if name == "tech_exposure":
        return render.tech_exposure(
            await client.get(
                "/api/exposure",
                {
                    "window_days": args.get("window_days", 180),
                    "product": (
                        _safe_slug(args["product"], "product") if args.get("product") else None
                    ),
                },
            )
        )

    if name == "stack_redundancy":
        return render.stack_redundancy(
            await client.get(f"/api/stacks/{_safe_slug(args['product'], 'product')}/redundancy")
        )

    if name == "tech_encounters":
        return render.tech_encounters(
            await client.get(f"/api/tech/{_safe_slug(args['tech'], 'tech')}/encounters")
        )

    if name == "stack_recommend":
        body = {k: args[k] for k in ("slot", "archetype") if args.get(k)}
        product = _safe_slug(args["product"], "product")
        return render.stack_recommend(
            await client.post(f"/api/stacks/{product}/recommend", body)
        )

    if name == "propose_binding":
        return await _propose(args)

    if name == "products":
        return render.products(await client.get("/api/products"))

    if name == "capability_inventory":
        return render.capability_inventory(
            await client.get("/api/capabilities/inventory"),
            args.get("q"),
            args.get("limit", 50),
        )

    if name == "check_idea":
        # A POST that only reads: the idea travels in the body, and the write
        # boundary exempts this exact path (app.auth.deps._READS_BY_POST).
        body = {
            "features": [
                {"name": f["name"], "capabilities": list(f["capabilities"])}
                for f in args["features"]
            ]
        }
        idea = (args.get("idea") or "").strip() or body["features"][0]["name"]
        return render.check_idea(
            await client.post("/api/capabilities/coverage", body), idea
        )

    if name == "product_score":
        product = await _product(args["product"])
        if product is None:
            return render.no_product(args["product"])
        if not product["external"]:
            return render.own_product(product)
        return render.product_score(
            await client.get(f"/api/products/{_safe_id(product['id'])}/coverage")
        )

    if name == "capability":
        return await _capability(args["slug"])

    if name == "feature_why":
        products = await client.get("/api/products")
        feature_id, named = await _feature_id(args["feature"])
        if feature_id is None:
            return render.no_feature(args["feature"], named, products)
        # The chain lists each goal once; the motivations say which
        # capability each goal motivates, the goals and products whose it is.
        return render.feature_why(
            await client.get(f"/api/features/{feature_id}/why"),
            await client.get(f"/api/features/{feature_id}"),
            products,
            await client.get("/api/goals"),
            await client.get("/api/motivations"),
        )

    if name == "journeys":
        value = args.get("journey")
        if not value:
            return render.journeys(await client.get("/api/journeys"))
        try:
            journey = _safe_id(value)
        except BadInput:
            named = [j for j in await client.get("/api/journeys") if j["name"] == value]
            if len(named) != 1:
                return render.no_journey(value, named)
            journey = _safe_id(named[0]["id"])
        return render.journey_analysis(await client.get(f"/api/journeys/{journey}/analysis"))

    if name == "ready_features":
        products = await client.get("/api/products")
        only = None
        if args.get("product"):
            only = _match_product(products, args["product"])
            if only is None:
                return render.no_product(args["product"])
        ready = (await client.get("/api/graph/ready"))["ready"]
        pending = None
        if not any(only is None or r["product_id"] == only["id"] for r in ready):
            pending = sum(
                1
                for f in await client.get("/api/features")
                if f["status"] == "pending"
                and not f["external"]
                and (only is None or f["product_id"] == only["id"])
            )
        return render.ready_features(ready, products, only, pending)

    if name == "recheck":
        return await _recheck(args["feature"])

    raise ValueError(f"Unknown tool: {name}")


def _match_product(products: list[dict], value: str) -> dict | None:
    """By id or by exact slug. Never by name: a near name is not a product."""
    return next((p for p in products if value in (p["id"], p["slug"])), None)


async def _product(value: str) -> dict | None:
    return _match_product(await client.get("/api/products"), value)


async def _feature_id(value: str) -> tuple[str | None, list[dict]]:
    """By id, or by exact name. Never a near name, and a name two features
    share comes back with those features for the agent to pick from, not
    picked. A name travels only as a query parameter, never in a path."""
    try:
        return _safe_id(value), []
    except BadInput:
        named = [f for f in await client.get("/api/features", {"q": value}) if f["name"] == value]
        return (_safe_id(named[0]["id"]) if len(named) == 1 else None), named


async def _recheck(value: str) -> str:
    products = await client.get("/api/products")
    feature_id, named = await _feature_id(value)
    if feature_id is None:
        return render.no_feature(value, named, products)
    return render.recheck(await client.get(f"/api/graph/recheck/{feature_id}"), products)


async def _capability(value: str) -> str:
    """By slug, or by a name matched through its slug — the coverage rule, so
    this finds what check_idea finds, and a renamed capability by its new name.
    Capability routes take an id; the inventory resolves one to the other and
    already carries who uses it, so it is read once."""
    slug = _capability_slug(value)
    entries = await client.get("/api/capabilities/inventory")
    entry = next((e for e in entries if e["slug"] == slug), None) or next(
        (e for e in entries if slugify(e["name"]) == slug), None
    )
    if entry is None:
        # The coverage endpoint's own near-name search, so the candidates are
        # the same ones a human would see — and they stay candidates.
        report = await client.post(
            "/api/capabilities/coverage",
            {"features": [{"name": value, "capabilities": [value]}]},
        )
        return render.no_capability(slug, report["features"][0]["capabilities"][0]["candidates"])
    cid = _safe_id(entry["id"])
    return render.capability(
        entry,
        await client.get(f"/api/capabilities/{cid}/scope"),
        await client.get(f"/api/capabilities/{cid}/motivations"),
        await client.get(f"/api/capabilities/{cid}/rollup"),
        await client.get("/api/products"),
    )


def _hard_stop(envelope: dict) -> str | None:
    """Two stop conditions, both traceable to an id someone wrote down: a
    `banned` stance and a blocking constraint. Everything else — `deprecated`,
    `contained`, `workaround`, no offer at all — comes back with its rationale
    so the agent can lose the argument out loud rather than quietly declining."""
    for entry in envelope.get("unresolved", []):
        if entry.get("blocked_by"):
            return render.blocked(
                entry["reason"], ", ".join(entry["blocked_by"]), envelope["href"]
            )
    for row in envelope.get("answer", []):
        if row.get("stance") == "banned":
            return render.blocked(
                f"{row['tech']} is banned — a constraint forbids it",
                f"adoptions:{row['tech']}",
                envelope["href"],
            )
    return None


async def _propose(args: dict) -> str:
    """Check the slot's offers before proposing. Proposing a technology the
    bind endpoint would reject is worse than proposing nothing — it costs the
    human a click to find out the agent was wrong."""
    slot, tech = _safe_id(args["slot"], "slot"), _safe_slug(args["tech"], "tech")
    href = f"/stacks?slot={slot}&propose={tech}"
    offers = await client.get(f"/api/stacks/slots/{slot}/offers")
    slugs = [o["slug"] for o in offers["offers"]]
    if tech not in slugs:
        blocked_by = offers.get("blocked_by") or []
        if blocked_by:
            return render.blocked(
                f"{tech} cannot answer this slot — every offer is blocked",
                ", ".join(blocked_by),
                href,
            )
        return "\n".join(
            [
                f"Not proposed: {tech} does not satisfy this slot's capability.",
                f"Offers that do: {', '.join(slugs) or 'none'}",
                "Record the satisfaction first, with its fit.",
                f"Open: /stacks?slot={slot}",
            ]
        )
    return render.propose_binding(slot, tech, args["rationale"], href)


# ---- resources ----
# Tools answer; resources teach. A tool call costs a round trip and returns a
# fact; a resource is pulled into context once and makes every later sentence
# use the right nouns.

RESOURCES = [
    Resource(
        uri=AnyUrl("metis://ontology/model"),
        name="The Metis ontology",
        description=(
            "The four planes, the entities, the invariants — the same document "
            "GET /api/ontology/model serves and the /ontology route renders."
        ),
        mimeType="text/markdown",
    ),
    Resource(
        uri=AnyUrl("metis://policy/adoptions"),
        name="Adoption policy",
        description=(
            "What each stance means, who owns promotion, which stances are hard "
            "stops. An agent that has read this stops at `banned` unprompted."
        ),
        mimeType="text/markdown",
    ),
]

RESOURCE_TEMPLATES = [
    ResourceTemplate(
        uriTemplate="metis://tech/{slug}",
        name="One catalog row",
        description="Satisfactions, versions, vendor and stance. Cheaper than three tool calls when the slug is known.",
        mimeType="application/json",
    ),
    ResourceTemplate(
        uriTemplate="metis://stacks/{product}",
        name="One product's stack",
        description="Slots by layer with gap, drift and redundancy already computed — the shape a coding agent needs before editing a dependency file.",
        mimeType="application/json",
    ),
]


@server.list_resources()
async def list_resources() -> list[Resource]:
    return RESOURCES


@server.list_resource_templates()
async def list_resource_templates() -> list[ResourceTemplate]:
    return RESOURCE_TEMPLATES


#: A slug is lowercase, digits and dashes — the same shape `slugify` produces.
#: Interpolating anything else into a request path lets a resource URI walk out
#: of `/api/tech/` and address the rest of the API with this server's token.
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]*\Z")


class BadInput(ValueError):
    """An argument that cannot be what it claims, refused before any request.
    The message names what the argument takes and where to find one."""


#: What each kind of argument is, and where an agent finds a valid one.
_TAKES = {
    "slug": ("a slug", "Slugs are lowercase letters, digits and dashes."),
    "id": ("an id", "Ids are UUIDs."),
    "tech": (
        "a technology slug",
        "Slugs are lowercase letters, digits and dashes; tech_search lists them.",
    ),
    "product": (
        "a product slug",
        "Slugs are lowercase letters, digits and dashes; products lists them.",
    ),
    "capability": ("a capability slug or name", "capability_inventory lists them."),
    "slot": (
        "a slot id",
        "Slot ids are UUIDs; the metis://stacks/{product} resource lists a product's slots.",
    ),
}


def _bad(value, kind: str) -> BadInput:
    what, where = _TAKES[kind]
    return BadInput(f"Not {what}: {value!r}. {where}")


def _safe_slug(value: str, kind: str = "slug") -> str:
    if not isinstance(value, str) or not _SLUG.match(value):
        raise _bad(value, kind)
    return value


def _safe_id(value: str, kind: str = "id") -> str:
    """Slot ids are UUIDs. Same reason as _safe_slug: everything interpolated
    into a request path has to be shaped like what it claims to be."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise _bad(value, kind) from None


def _capability_slug(value: str) -> str:
    """A capability slug, or a name matched through its slug — check_idea's
    rule. Only `slugify`'s output reaches a path, never the value itself."""
    slug = slugify(value) if isinstance(value, str) else ""
    if not slug:
        raise _bad(value, "capability")
    return slug


@server.read_resource()
async def read_resource(uri: AnyUrl) -> str:
    raw = str(uri)
    if raw == "metis://ontology/model":
        return await client.text("/api/ontology/model")
    if raw == "metis://policy/adoptions":
        return await client.text("/api/ontology/adoptions")
    if raw.startswith("metis://tech/"):
        slug = _safe_slug(raw.removeprefix("metis://tech/"))
        return json.dumps(await client.get(f"/api/tech/{slug}"), indent=2)
    if raw.startswith("metis://stacks/"):
        product = _safe_slug(raw.removeprefix("metis://stacks/"))
        found = await _product(product)
        if found is None:
            raise ValueError(f"No product {product!r} in metis. Open: /products")
        stacks = await client.get("/api/stacks", {"product_id": found["id"]})
        views = [await client.get(f"/api/stacks/{stack['id']}") for stack in stacks]
        return json.dumps(
            {"product": product, "stacks": views}, indent=2, default=str
        )
    raise ValueError(f"Unknown resource: {uri}")


# ---- prompts ----
# Three, because three is what people will actually pick from.

PROMPTS = [
    Prompt(
        name="check_this_dependency",
        description=(
            "Before adding a package: does the group have a stance, is anything "
            "exposed, has anyone here shipped it, and does a standard already "
            "answer the same capability?"
        ),
        arguments=[
            {"name": "package", "description": "Package or technology name", "required": True}
        ],
    ),
    Prompt(
        name="choose_a_stack",
        description=(
            "Walk a product's archetype slot by slot, resolve what resolves, "
            "and stop at the gaps rather than guessing past them."
        ),
        arguments=[{"name": "product", "description": "Product slug", "required": True}],
    ),
    Prompt(
        name="explain_the_ontology",
        description="Answer in the project's vocabulary — Capability, Slot, SATISFIES, stance.",
        arguments=[],
    ),
]


@server.list_prompts()
async def list_prompts() -> list[Prompt]:
    return PROMPTS


@server.get_prompt()
async def get_prompt(name: str, arguments: dict | None) -> GetPromptResult:
    args = arguments or {}
    if name == "check_this_dependency":
        package = args.get("package", "")
        body = (
            f"I am about to add `{package}` to this codebase. Before I do, check "
            "the Metis catalog and tell me whether I should.\n\n"
            f"1. `tech_search` for `{package}` to get its slug. If it is not in "
            "the catalog, say so — that is an answer, not a failure.\n"
            "2. `tech_exposure` — is it dying, and does that matter here?\n"
            "3. `tech_encounters` — has anyone here shipped it? Name them.\n"
            "4. For each capability it satisfies, `capability_supply` — does a "
            "technology the group already runs answer the same capability?\n\n"
            "Stop if its stance is `banned` or a blocking constraint applies, and "
            "cite the id. If the stance is `deprecated` or `contained`, say so "
            "and make the argument for or against out loud. End with the link."
        )
    elif name == "choose_a_stack":
        product = args.get("product", "")
        body = (
            f"Propose a stack for `{product}`.\n\n"
            f"1. `stack_recommend` with product `{product}`.\n"
            "2. For any slot left unresolved, `capability_supply` on its "
            "capability to show what was considered and why nothing survived.\n"
            "3. `stack_redundancy` — is anything answered twice?\n\n"
            "Report the bindings with their rationale, then the gaps. **Do not "
            "guess past a gap.** An empty required slot is information the PRD "
            "has to answer before tickets are cut; a plausible wrong binding is "
            "not. If you want to suggest a binding, use `propose_binding` — it "
            "writes nothing and hands the human a link."
        )
    elif name == "explain_the_ontology":
        body = (
            "Read the `metis://ontology/model` resource, then answer my "
            "questions about this system using its vocabulary exactly — "
            "Capability, Feature, Technology, Slot, `REALIZES`, `SATISFIES`, "
            "stance, fit. Do not invent synonyms; if I use a different word, map "
            "it to the model's word and say which you are using."
        )
    else:
        raise ValueError(f"Unknown prompt: {name}")
    return GetPromptResult(
        description=next(p.description for p in PROMPTS if p.name == name),
        messages=[
            PromptMessage(role="user", content=TextContent(type="text", text=body))
        ],
    )
