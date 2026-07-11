"""Agent tools. Executors wrap the same services the REST routers use, so
agents and the API share one write path (including graph write-through).

Each executor returns (result_json_str, viz_blocks). Viz blocks are attached
deterministically here - never formatted by the model.
"""

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.types import ToolDef
from app.models import Feature, Goal, Product, Ticket
from app.schemas.feature import EdgeCreate, FeatureCreate, FeatureUpdate
from app.schemas.prd import PRDDocument
from app.schemas.strategy import StrategyCreate
from app.schemas.work import TicketCreate, TicketUpdate
from app.services import decomposition as decomposition_service
from app.services import features as feature_service
from app.services import search as search_service
from app.services import strategies as strategy_service
from app.services import tickets as ticket_service


@dataclass
class ToolContext:
    session: AsyncSession
    graph: Any = None


@dataclass
class ToolResult:
    result: str
    viz: list[dict[str, Any]] = field(default_factory=list)


class ToolError(Exception):
    pass


# ---- reference resolution (agents may pass UUIDs, display IDs, or names) ----

async def _resolve(session, model, ref: str, prefix: str, name_column=None):
    ref = (ref or "").strip()
    try:
        obj = await session.get(model, uuid.UUID(ref))
        if obj is not None:
            return obj
    except ValueError:
        pass
    match = re.fullmatch(rf"{prefix}-?0*(\d+)", ref, re.IGNORECASE)
    if match:
        obj = await session.scalar(select(model).where(model.seq == int(match.group(1))))
        if obj is not None:
            return obj
    if name_column is not None:
        obj = await session.scalar(select(model).where(name_column.ilike(f"%{ref}%")).limit(1))
        if obj is not None:
            return obj
    raise ToolError(f"Could not resolve `{ref}` to a known {model.__tablename__[:-1]}")


def _feature_dict(f: Feature) -> dict[str, Any]:
    return {
        "id": str(f.id),
        "display_id": f"FTR-{f.seq:03d}",
        "name": f.name,
        "type": str(f.type),
        "status": str(f.status),
        "priority": f.priority,
        "priority_rationale": f.priority_rationale,
    }


def _ticket_dict(t: Ticket) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "display_id": f"TKT-{t.seq:04d}",
        "title": t.title,
        "description": t.description,
        "status": str(t.status),
        "context_budget": str(t.context_budget),
        "affected_files": list(t.affected_files or []),
    }


def _ticket_card(t: Ticket) -> dict[str, Any]:
    return {
        "type": "ticket_card",
        "data": {
            "id": f"TKT-{t.seq:04d}",
            "ticket_id": str(t.id),
            "title": t.title,
            "description": t.description,
            "status": str(t.status),
            "budget": str(t.context_budget),
            "files": list(t.affected_files or []),
        },
    }


def _dump(payload: Any) -> str:
    return json.dumps(payload, default=str)


# ---- shared read tools ----

async def list_goals(ctx: ToolContext) -> ToolResult:
    goals = (await ctx.session.scalars(select(Goal).order_by(Goal.seq))).all()
    return ToolResult(_dump([
        {
            "id": str(g.id),
            "display_id": ("OG" if g.goal_type == "org" else "PG") + f"-{g.seq:02d}",
            "goal_type": str(g.goal_type),
            "title": g.title,
            "success_criteria": g.success_criteria,
            "priority": g.priority,
            "status": str(g.status),
        }
        for g in goals
    ]))


async def list_products(ctx: ToolContext) -> ToolResult:
    products = (await ctx.session.scalars(select(Product).order_by(Product.seq))).all()
    return ToolResult(_dump([
        {
            "id": str(p.id),
            "display_id": f"SPEC-{p.seq:03d}",
            "name": p.name,
            "summary": p.summary,
            "status": str(p.status),
            "version": p.version,
        }
        for p in products
    ]))


async def list_features(ctx: ToolContext) -> ToolResult:
    features = await feature_service.list_features(ctx.session)
    return ToolResult(_dump([_feature_dict(f) for f in features]))


async def search_features(ctx: ToolContext, query: str) -> ToolResult:
    features = await search_service.search_features(ctx.session, query)
    return ToolResult(_dump([_feature_dict(f) for f in features]))


# ---- spec_decomposer tools ----

async def create_product_spec(
    ctx: ToolContext, name: str, summary: str, body: str = "", goal: str = ""
) -> ToolResult:
    goal_id = None
    if goal:
        goal_obj = await _resolve(ctx.session, Goal, goal, "(?:PG|OG)", Goal.title)
        goal_id = goal_obj.id
    product = Product(goal_id=goal_id, name=name, summary=summary, body=body or None)
    ctx.session.add(product)
    await ctx.session.commit()
    await ctx.session.refresh(product)
    return ToolResult(_dump({"id": str(product.id), "display_id": f"SPEC-{product.seq:03d}", "name": product.name}))


async def create_prd_draft(ctx: ToolContext, product: str, document: dict) -> ToolResult:
    product_obj = await _resolve(ctx.session, Product, product, "SPEC", Product.name)
    try:
        prd = PRDDocument.model_validate(document)
    except Exception as e:
        raise ToolError(f"Invalid PRD document: {e}") from None
    try:
        decomposition = await decomposition_service.create_prd_draft(
            ctx.session, product_obj.id, prd, created_by="spec_decomposer"
        )
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    tickets = await ticket_service.list_tickets(ctx.session, product_obj.id)
    l_tickets = [t for t in tickets if str(t.context_budget) == "L"]
    result = {
        "display_id": f"PRD-{decomposition.seq:03d}",
        "version": decomposition.version,
        "status": str(decomposition.status),
        "epics": len(prd.epics),
        "tickets": len(tickets),
        "l_tickets_needing_split": [_ticket_dict(t) for t in l_tickets],
    }
    viz = [_ticket_card(t) for t in tickets[:3]]
    return ToolResult(_dump(result), viz)


async def create_ticket(
    ctx: ToolContext,
    product: str,
    title: str,
    description: str = "",
    technical_approach: str = "",
    acceptance_criteria: str = "",
    affected_files: list[str] | None = None,
    context_budget: str = "M",
    epic_id: str = "",
    story_id: str = "",
) -> ToolResult:
    product_obj = await _resolve(ctx.session, Product, product, "SPEC", Product.name)
    try:
        data = TicketCreate(
            product_id=product_obj.id,
            epic_id=uuid.UUID(epic_id) if epic_id else None,
            story_id=uuid.UUID(story_id) if story_id else None,
            title=title,
            description=description or None,
            technical_approach=technical_approach or None,
            acceptance_criteria=acceptance_criteria or None,
            affected_files=affected_files or [],
            context_budget=context_budget,
        )
        ticket = await ticket_service.create_ticket(ctx.session, data)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump(_ticket_dict(ticket)), [_ticket_card(ticket)])


async def update_ticket(ctx: ToolContext, ticket: str, **fields) -> ToolResult:
    ticket_obj = await _resolve(ctx.session, Ticket, ticket, "TKT", Ticket.title)
    try:
        data = TicketUpdate(**{k: v for k, v in fields.items() if v not in (None, "")})
        updated = await ticket_service.update_ticket(ctx.session, ticket_obj.id, data)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump(_ticket_dict(updated)), [_ticket_card(updated)])


# ---- feature_manager tools ----

async def create_feature(
    ctx: ToolContext,
    name: str,
    description: str = "",
    type: str = "capability",
    priority: int | None = None,
    product: str = "",
) -> ToolResult:
    product_id = None
    if product:
        product_obj = await _resolve(ctx.session, Product, product, "SPEC", Product.name)
        product_id = product_obj.id
    try:
        data = FeatureCreate(
            name=name, description=description or None, type=type,
            priority=priority, product_id=product_id,
        )
        feature = await feature_service.create_feature(ctx.session, data, ctx.graph)
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump(_feature_dict(feature)))


async def update_feature(ctx: ToolContext, feature: str, **fields) -> ToolResult:
    feature_obj = await _resolve(ctx.session, Feature, feature, "FTR", Feature.name)
    try:
        data = FeatureUpdate(**{k: v for k, v in fields.items() if v not in (None, "")})
        updated = await feature_service.update_feature(ctx.session, feature_obj.id, data, ctx.graph)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump(_feature_dict(updated)))


async def link_features(ctx: ToolContext, src: str, dst: str, kind: str = "DEPENDS_ON") -> ToolResult:
    src_obj = await _resolve(ctx.session, Feature, src, "FTR", Feature.name)
    dst_obj = await _resolve(ctx.session, Feature, dst, "FTR", Feature.name)
    try:
        data = EdgeCreate(src_id=src_obj.id, dst_id=dst_obj.id, kind=kind)
        edge = await feature_service.create_edge(ctx.session, data, ctx.graph)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump({
        "edge_id": str(edge.id),
        "src": _feature_dict(src_obj), "kind": str(edge.kind), "dst": _feature_dict(dst_obj),
        "meaning": f"{src_obj.name} {edge.kind} {dst_obj.name}",
    }))


# ---- graph_agent tools ----

async def impact_query(ctx: ToolContext, feature: str) -> ToolResult:
    feature_obj = await _resolve(ctx.session, Feature, feature, "FTR", Feature.name)
    await ctx.graph.ensure_fresh()
    impact = ctx.graph.impact(feature_obj.id)
    return ToolResult(_dump({"feature": _feature_dict(feature_obj), **impact}))


async def topo_order(ctx: ToolContext) -> ToolResult:
    from app.services.graph_service import GraphCycleError

    await ctx.graph.ensure_fresh()
    try:
        return ToolResult(_dump({"order": ctx.graph.topo_order()}))
    except GraphCycleError as e:
        raise ToolError(
            f"Dependency cycle detected across {len(e.cycle)} features - break it first "
            f"(see find_cycles)."
        ) from None


async def find_cycles(ctx: ToolContext) -> ToolResult:
    await ctx.graph.ensure_fresh()
    return ToolResult(_dump({"cycles": ctx.graph.find_cycles()}))


# ---- strategist tools ----

async def set_feature_priority(
    ctx: ToolContext, feature: str, priority: int, rationale: str
) -> ToolResult:
    feature_obj = await _resolve(ctx.session, Feature, feature, "FTR", Feature.name)
    try:
        data = FeatureUpdate(priority=priority, priority_rationale=rationale)
        updated = await feature_service.update_feature(ctx.session, feature_obj.id, data, ctx.graph)
    except ValueError as e:
        raise ToolError(str(e)) from None
    return ToolResult(_dump(_feature_dict(updated)))


async def create_delivery_strategy(
    ctx: ToolContext, product: str, phases: list[dict], rationale: str = ""
) -> ToolResult:
    product_obj = await _resolve(ctx.session, Product, product, "SPEC", Product.name)
    data = StrategyCreate(phases=phases, rationale=rationale or None, created_by="strategist")
    strategy = await strategy_service.create_strategy(ctx.session, product_obj.id, data)
    return ToolResult(_dump({
        "display_id": f"STR-{strategy.seq:02d}",
        "version": strategy.version,
        "phases": strategy.phases,
    }))


# ---- registry ----

_STR = {"type": "string"}
_PRD_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": _STR,
        "epics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": _STR,
                    "acceptance_criteria": _STR,
                    "stories": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": _STR,
                                "description": _STR,
                                "tickets": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "title": _STR,
                                            "description": _STR,
                                            "technical_approach": _STR,
                                            "acceptance_criteria": _STR,
                                            "affected_files": {"type": "array", "items": _STR},
                                            "context_budget": {"type": "string", "enum": ["S", "M", "L"]},
                                        },
                                        "required": ["title"],
                                    },
                                },
                            },
                            "required": ["title"],
                        },
                    },
                },
                "required": ["title"],
            },
        },
    },
    "required": ["epics"],
}


def _tool(name, description, properties, required, executor) -> tuple[ToolDef, Any]:
    return (
        ToolDef(
            name=name,
            description=description,
            input_schema={"type": "object", "properties": properties, "required": required},
        ),
        executor,
    )


SHARED_TOOLS = [
    _tool("list_goals", "List all org and product goals with IDs, criteria, priority, status.", {}, [], list_goals),
    _tool("list_products", "List all products (Specs) with IDs, names, status, version.", {}, [], list_products),
    _tool("list_features", "List all features in the library with IDs, type, status, priority.", {}, [], list_features),
    _tool("search_features", "Find features like a query string (trigram + keyword search). Use before creating features to avoid duplicates.", {"query": _STR}, ["query"], search_features),
]

AGENT_TOOLS: dict[str, list[tuple[ToolDef, Any]]] = {
    "spec_decomposer": SHARED_TOOLS + [
        _tool("create_product_spec", "Create a new product Spec. summary = what it does, not how. Optionally link to a goal by ID (PG-xx) or title.", {"name": _STR, "summary": _STR, "body": _STR, "goal": _STR}, ["name", "summary"], create_product_spec),
        _tool("create_prd_draft", "Create a new versioned PRD draft for a product and materialize its epics, stories, and tickets. Replaces the previous draft while all tickets are pending. product = UUID, SPEC-xxx, or name.", {"product": _STR, "document": _PRD_SCHEMA}, ["product", "document"], create_prd_draft),
        _tool("create_ticket", "Create a single ticket under a product (optionally under an epic/story UUID). context_budget: S, M, or L.", {"product": _STR, "title": _STR, "description": _STR, "technical_approach": _STR, "acceptance_criteria": _STR, "affected_files": {"type": "array", "items": _STR}, "context_budget": {"type": "string", "enum": ["S", "M", "L"]}, "epic_id": _STR, "story_id": _STR}, ["product", "title"], create_ticket),
        _tool("update_ticket", "Update a ticket by UUID, TKT-xxxx, or title. Only pass fields to change.", {"ticket": _STR, "title": _STR, "description": _STR, "technical_approach": _STR, "acceptance_criteria": _STR, "affected_files": {"type": "array", "items": _STR}, "context_budget": {"type": "string", "enum": ["S", "M", "L"]}, "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}}, ["ticket"], update_ticket),
    ],
    "feature_manager": SHARED_TOOLS + [
        _tool("create_feature", "Create a feature. type: capability | integration | ui | infra. priority 1-5 (1 hottest). Optionally scope to a product.", {"name": _STR, "description": _STR, "type": {"type": "string", "enum": ["capability", "integration", "ui", "infra"]}, "priority": {"type": "integer", "minimum": 1, "maximum": 5}, "product": _STR}, ["name"], create_feature),
        _tool("update_feature", "Update a feature by UUID, FTR-xxx, or name. Only pass fields to change.", {"feature": _STR, "name": _STR, "description": _STR, "type": {"type": "string", "enum": ["capability", "integration", "ui", "infra"]}, "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}, "priority": {"type": "integer", "minimum": 1, "maximum": 5}, "priority_rationale": _STR}, ["feature"], update_feature),
        _tool("link_features", "Create a typed edge src -> dst. `src DEPENDS_ON dst` means src needs dst. Kinds: DEPENDS_ON, BLOCKS, RELATES_TO, PART_OF.", {"src": _STR, "dst": _STR, "kind": {"type": "string", "enum": ["DEPENDS_ON", "BLOCKS", "RELATES_TO", "PART_OF"]}}, ["src", "dst"], link_features),
    ],
    "graph_agent": SHARED_TOOLS + [
        _tool("impact_query", "For a feature: which features transitively depend on it (dependents = blast radius) and what it depends on (dependencies).", {"feature": _STR}, ["feature"], impact_query),
        _tool("topo_order", "All features ordered dependencies-first (safe build order). Fails if the graph has a cycle.", {}, [], topo_order),
        _tool("find_cycles", "List dependency cycles in the feature graph.", {}, [], find_cycles),
    ],
    "strategist": SHARED_TOOLS + [
        _tool("set_feature_priority", "Set a feature's priority (1-5, 1 hottest) with the scoring rationale (e.g. RICE numbers).", {"feature": _STR, "priority": {"type": "integer", "minimum": 1, "maximum": 5}, "rationale": _STR}, ["feature", "priority", "rationale"], set_feature_priority),
        _tool("create_delivery_strategy", "Create a new versioned delivery strategy for a product. phases: [{name, start, length}] in relative units.", {"product": _STR, "phases": {"type": "array", "items": {"type": "object", "properties": {"name": _STR, "start": {"type": "number"}, "length": {"type": "number"}}, "required": ["name"]}}, "rationale": _STR}, ["product", "phases"], create_delivery_strategy),
    ],
}


def tools_for(agent_name: str) -> list[ToolDef]:
    return [t for t, _ in AGENT_TOOLS.get(agent_name, [])]


async def execute_tool(agent_name: str, tool_name: str, arguments: dict, ctx: ToolContext) -> ToolResult:
    for tool_def, executor in AGENT_TOOLS.get(agent_name, []):
        if tool_def.name == tool_name:
            return await executor(ctx, **arguments)
    raise ToolError(f"Unknown tool `{tool_name}` for agent `{agent_name}`")
