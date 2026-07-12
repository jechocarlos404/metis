"""Demo seed reproducing the Metis design-system UI kit's reference data.

Explicit `seq` values match the display IDs shown in the kit (TKT-0142,
SPEC-004, ...); sequences are bumped past the seeded maxima
afterwards. Idempotent: skipped when any goal exists.
"""

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import (
    AgentLLMConfig,
    Capability,
    CapabilityMaturity,
    ChatMessage,
    ChatThread,
    ContextBudget,
    DeliveryStrategy,
    DocStatus,
    EdgeKind,
    Epic,
    Feature,
    FeatureEdge,
    Goal,
    GoalType,
    Motivation,
    Product,
    ProductDecomposition,
    Story,
    Ticket,
    WorkStatus,
)

AGENT_NAMES = ["orchestrator", "spec_decomposer", "feature_manager", "graph_agent", "strategist"]
DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-opus-4-8"


async def seed_demo_data(sessionmaker: async_sessionmaker[AsyncSession]) -> bool:
    async with sessionmaker() as session:
        if await session.scalar(select(func.count()).select_from(Goal)):
            await _ensure_agent_configs(session)
            return False

        # --- Goals ---
        org = Goal(
            seq=4,
            goal_type=GoalType.org,
            title="Be the default tool for product teams",
            description="Top-level intent: Metis is the tool product teams reach for first.",
            status=WorkStatus.in_progress,
        )
        session.add(org)
        await session.flush()

        product_goals = [
            Goal(
                seq=1,
                goal_type=GoalType.product,
                parent_goal_id=org.id,
                title="Ship PM export to 3 trackers",
                success_criteria="Jira, Linear, Notion round-trip by Q4",
                priority=1,
                status=WorkStatus.in_progress,
            ),
            Goal(
                seq=2,
                goal_type=GoalType.product,
                parent_goal_id=org.id,
                title="Feature graph answers impact queries < 2s",
                success_criteria="p95 latency on 10k-node graphs",
                priority=2,
                status=WorkStatus.in_progress,
            ),
            Goal(
                seq=3,
                goal_type=GoalType.product,
                parent_goal_id=org.id,
                title="Every generated ticket fits one Claude session",
                success_criteria="0 L-tickets in approved PRDs",
                priority=1,
                status=WorkStatus.pending,
            ),
        ]
        session.add_all(product_goals)
        await session.flush()

        # --- Product (Spec) ---
        product = Product(
            seq=4,
            goal_id=product_goals[0].id,
            name="PM Export — ticket delivery to external trackers",
            summary="Tickets export to Jira, Linear, and Notion via the pm_backends "
            "protocol. Each exported ticket stores its external ID. "
            "What it does, not how.",
            body="Capabilities: export approved tickets to external trackers; store "
            "external IDs back on tickets; per-backend field mapping.\n"
            "Constraints: backends satisfy a single TicketItem protocol; export is "
            "one-way in v1.\nScope: Jira first, Linear phase 2, Notion completion last.",
            status=DocStatus.draft,
            version=3,
        )
        session.add(product)
        await session.flush()

        # --- Capability map (slow plane: nouns that mature, never ship) ---
        cap_intel = Capability(
            seq=1,
            name="Feature intelligence",
            description="The product understands its own feature library: search it, "
            "traverse it, answer impact questions from it.",
            maturity=CapabilityMaturity.ga,
            evidence_anchors=["backend/app/services/search.py", "backend/app/services/graph_service.py"],
        )
        session.add(cap_intel)
        await session.flush()
        cap_search = Capability(
            seq=2,
            parent_id=cap_intel.id,
            name="Feature search",
            description="Find features like X — ranked lookup over the library.",
            maturity=CapabilityMaturity.ga,
            evidence_anchors=["backend/app/services/search.py"],
        )
        cap_graph = Capability(
            seq=3,
            parent_id=cap_intel.id,
            name="Feature graph",
            description="Typed dependency graph with impact, build order, and cycles.",
            maturity=CapabilityMaturity.beta,
            evidence_anchors=["backend/app/services/graph_service.py"],
        )
        cap_export = Capability(
            seq=4,
            name="Ticket export",
            description="Approved tickets flow to external trackers and carry their "
            "external IDs back.",
            maturity=CapabilityMaturity.alpha,
        )
        session.add_all([cap_search, cap_graph, cap_export])
        await session.flush()

        # Why layer: goals MOTIVATE capabilities. PG-3 is deliberately left
        # unmotivated so /api/capabilities/health has a demo finding.
        session.add_all(
            [
                Motivation(goal_id=product_goals[0].id, capability_id=cap_export.id),
                Motivation(goal_id=product_goals[1].id, capability_id=cap_graph.id),
            ]
        )

        # --- Features (fast plane: changes that REALIZE capabilities) ---
        def feature(seq, name, capability, layer, priority, status, description, rationale=None):
            return Feature(
                seq=seq,
                capability_id=capability.id,
                name=name,
                description=description,
                facets={"layer": layer},
                priority=priority,
                priority_rationale=rationale,
                status=status,
            )

        features = {
            31: feature(31, "Semantic feature search", cap_search, "service", 1,
                        WorkStatus.done, "Find features like X — trigram-ranked search over the library.",
                        "Set by strategist (RICE)"),
            32: feature(32, "Feature graph traversal", cap_graph, "service", 2,
                        WorkStatus.done, "Impact queries and dependency walks over the in-memory graph."),
            40: feature(40, "Ticket export protocol", cap_export, "integration", 1,
                        WorkStatus.in_progress, "Single TicketItem protocol every PM backend satisfies.",
                        "Set by strategist (RICE)"),
            41: feature(41, "Jira backend", cap_export, "integration", 2,
                        WorkStatus.in_progress, "Create/update/status round-trip against Jira.",
                        "Set by strategist (RICE)"),
            42: feature(42, "Linear backend", cap_export, "integration", 4,
                        WorkStatus.pending, "Phase 2 — create() only."),
            50: feature(50, "Graph visualization", cap_graph, "ui", 3,
                        WorkStatus.pending, "Positioned node cards with dependency edges and a detail rail."),
        }
        session.add_all(features.values())
        await session.flush()

        # Kit edge [a, b] renders a→b with "b depends on a"; stored as b DEPENDS_ON a.
        for dependent, dependency in [(32, 31), (41, 31), (41, 40), (42, 40), (50, 32), (50, 31)]:
            session.add(
                FeatureEdge(
                    src_id=features[dependent].id,
                    dst_id=features[dependency].id,
                    kind=EdgeKind.DEPENDS_ON,
                )
            )

        # --- PRD v3 (draft) + materialized epics/stories/tickets ---
        prd_epics = [
            ("Export protocol hardening", "All backends satisfy TicketItem protocol; contract tests green.", "Protocol contract"),
            ("Jira parity", "create/update/status round-trip verified against sandbox.", "Jira round-trip"),
            ("Linear backend", "Phase 2; create() only.", "Linear create()"),
        ]
        tickets_by_epic = {
            0: [
                (138, "Define TicketItem protocol dataclass", "Frozen dataclass with the fields every backend consumes.",
                 WorkStatus.done, ContextBudget.S, ["protocol.py"]),
                (139, "Contract tests for backend protocol", "Shared test suite every backend implementation must pass.",
                 WorkStatus.done, ContextBudget.M, ["test_protocol.py", "protocol.py"]),
                (141, "Create products table migration", "Rename projects → products; keep UUID PKs.",
                 WorkStatus.done, ContextBudget.S, ["migration.sql"]),
                (142, "Add priority_rationale to features", "Done when the column is queryable via the API.",
                 WorkStatus.in_progress, ContextBudget.M, ["features.entity.ts", "migration.sql"]),
            ],
            1: [
                (131, "Jira auth via API token", "Token from env; fail fast with a clear error when missing.",
                 WorkStatus.done, ContextBudget.S, ["jira_backend.py"]),
                (132, "Map ticket fields to Jira issue schema", "Title, description, AC → Jira fields; budget → story points.",
                 WorkStatus.pending, ContextBudget.M, ["jira_backend.py", "protocol.py"]),
                (133, "Create Jira issues from tickets", "backend.create() returns the external ID stored on the ticket.",
                 WorkStatus.pending, ContextBudget.M, ["jira_backend.py"]),
                (134, "Sync ticket status from Jira", "Round-trip status on demand; no webhooks in v1.",
                 WorkStatus.pending, ContextBudget.M, ["jira_backend.py", "tickets.py"]),
                (135, "Handle Jira rate limits", "Retry with backoff on 429; surface exhaustion as export failure.",
                 WorkStatus.pending, ContextBudget.S, ["jira_backend.py"]),
            ],
            2: [
                (136, "Linear API client scaffold", "GraphQL client with auth and a create-issue mutation.",
                 WorkStatus.pending, ContextBudget.S, ["linear_backend.py"]),
                (137, "Map context_budget to Linear estimate", "S/M/L → Linear estimate points.",
                 WorkStatus.pending, ContextBudget.S, ["linear_backend.py"]),
                (143, "Wire TicketExporterAgent to Linear", "Needs split — cross-cutting agent + backend change.",
                 WorkStatus.pending, ContextBudget.L, ["protocol.py", "linear_backend.py", "jira_writer.py"]),
            ],
        }

        # Epics pin the capability they snapshot; stories pin the feature.
        # The taxonomy stays canonical — this document is a photograph of it.
        story_feature = {0: features[40], 1: features[41], 2: features[42]}
        prd_document = {
            "summary": "PM export: protocol hardening, Jira parity, Linear backend.",
            "epics": [
                {
                    "title": title,
                    "acceptance_criteria": ac,
                    "capability_id": str(cap_export.id),
                    "stories": [
                        {
                            "title": story_title,
                            "description": None,
                            "feature_id": str(story_feature[i].id),
                            "tickets": [
                                {
                                    "title": t[1],
                                    "description": t[2],
                                    "technical_approach": None,
                                    "acceptance_criteria": None,
                                    "affected_files": t[5],
                                    "context_budget": t[4].value,
                                }
                                for t in tickets_by_epic[i]
                            ],
                        }
                    ],
                }
                for i, (title, ac, story_title) in enumerate(prd_epics)
            ],
        }
        decomposition = ProductDecomposition(
            seq=7,
            product_id=product.id,
            version=3,
            document=prd_document,
            status=DocStatus.draft,
            created_by="spec_decomposer",
        )
        session.add(decomposition)
        await session.flush()

        ticket_142 = None
        for i, (title, ac, story_title) in enumerate(prd_epics):
            epic = Epic(
                product_id=product.id,
                decomposition_id=decomposition.id,
                capability_id=cap_export.id,
                title=title,
                acceptance_criteria=ac,
                position=i,
            )
            session.add(epic)
            await session.flush()
            story = Story(
                epic_id=epic.id, feature_id=story_feature[i].id, title=story_title, position=0
            )
            session.add(story)
            await session.flush()
            for pos, (seq, t_title, desc, status, budget, files) in enumerate(tickets_by_epic[i]):
                ticket = Ticket(
                    seq=seq,
                    product_id=product.id,
                    epic_id=epic.id,
                    story_id=story.id,
                    title=t_title,
                    description=desc,
                    affected_files=files,
                    context_budget=budget,
                    status=status,
                    position=pos,
                )
                session.add(ticket)
                if seq == 142:
                    ticket_142 = ticket
        await session.flush()

        # --- Delivery strategy (kit gantt tab: strategist · v2) ---
        session.add_all(
            [
                DeliveryStrategy(
                    product_id=product.id,
                    version=1,
                    phases=[
                        {"name": "Phase 1 — protocol + Jira", "start": 0, "length": 320},
                        {"name": "Phase 2 — Linear + Notion", "start": 200, "length": 220},
                    ],
                    rationale="Initial cut before Linear was split out.",
                    created_by="strategist",
                ),
                DeliveryStrategy(
                    product_id=product.id,
                    version=2,
                    phases=[
                        {"name": "Phase 1 — protocol + Jira", "start": 0, "length": 280},
                        {"name": "Phase 2 — Linear backend", "start": 120, "length": 180},
                        {"name": "Phase 3 — Notion completion", "start": 240, "length": 140},
                    ],
                    rationale="Linear pulled forward; Notion completion is not on the critical path.",
                    created_by="strategist",
                ),
            ]
        )

        # --- Welcome chat thread (kit ChatScreen seed messages) ---
        thread = ChatThread(title="prd-007-decomposition")
        session.add(thread)
        await session.flush()
        session.add_all(
            [
                ChatMessage(
                    thread_id=thread.id,
                    role="user",
                    content="Decompose the PM-export spec into tickets.",
                ),
                ChatMessage(
                    thread_id=thread.id,
                    role="agent",
                    agent_name="spec_decomposer",
                    content="Decomposed Spec PRD-007 into 3 epics, 3 stories, 12 tickets. "
                    "One ticket came back L — split into S/M before the PRD can be "
                    "marked ready. First ticket below.",
                    viz=[
                        {
                            "type": "ticket_card",
                            "data": {
                                "id": "TKT-0142",
                                "ticket_id": str(ticket_142.id),
                                "title": ticket_142.title,
                                "description": ticket_142.description,
                                "status": "pending",
                                "budget": "M",
                                "files": list(ticket_142.affected_files),
                            },
                        }
                    ],
                ),
            ]
        )

        await session.commit()

        # Bump identity sequences past the explicit seed values.
        for table in ("goals", "products", "product_decompositions", "capabilities", "features", "tickets"):
            await session.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'seq'), "
                    f"(SELECT COALESCE(MAX(seq), 1) FROM {table}))"
                )
            )
        await session.commit()

        await _ensure_agent_configs(session)
        return True


async def _ensure_agent_configs(session: AsyncSession) -> None:
    """Agent LLM configs are seeded even when demo data is skipped."""
    existing = {
        c.agent_name for c in (await session.scalars(select(AgentLLMConfig))).all()
    }
    missing = [name for name in AGENT_NAMES if name not in existing]
    for name in missing:
        session.add(
            AgentLLMConfig(agent_name=name, provider=DEFAULT_PROVIDER, model=DEFAULT_MODEL)
        )
    if missing:
        await session.commit()
