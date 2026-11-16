"""Admin cascade delete — closure correctness, atomicity, and the gates.

The single fact this suite exists to pin: a capability that `delete_capability`
refuses with a 409 is deleted by the cascade path, and everything that went with
it was named in the preview first.
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text

from app.auth import Principal, authorize
from app.auth.deps import require_admin
from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import (
    Capability,
    Epic,
    Feature,
    FeatureEdge,
    Goal,
    GoalType,
    Motivation,
    Product,
    ProductBundle,
    Story,
    TechFit,
    TechKind,
    TechSatisfaction,
    Technology,
    Ticket,
)
from app.models.enums import EdgeKind, Surface
from app.schemas.admin import RowRef
from app.schemas.capability import CapabilityCreate
from app.schemas.feature import EdgeCreate, FeatureCreate
from app.services import admin_cascade
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.admin_cascade import CHILDREN
from app.services.graph_service import FeatureGraph


@pytest_asyncio.fixture
async def client(db):
    """No lifespan, so app.state.graph is unset — deliberate: the cascade path
    must tolerate a missing graph, and these tests assert HTTP behaviour."""
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http


async def make_capability(session, name, parent_id=None):
    return await capability_service.create_capability(
        session, CapabilityCreate(name=name, parent_id=parent_id)
    )


async def make_feature(session, name, capability_id, graph=None):
    return await feature_service.create_feature(
        session, FeatureCreate(name=name, capability_ids=[capability_id]), graph
    )


async def seed_estate(session, graph=None):
    """goal -> motivation -> parent capability -> child capability
       -> 2 features + a DEPENDS_ON edge, a product bundling the parent,
       a tech satisfaction on the parent, an epic pinned to the child.
    """
    goal = Goal(goal_type=GoalType.product, title="ship the thing")
    product = Product(slug="metis", name="Metis")
    tech = Technology(slug="pg", name="Postgres", kind=TechKind.service)
    session.add_all([goal, product, tech])
    await session.commit()

    parent = await make_capability(session, "feature intelligence")
    child = await make_capability(session, "feature search", parent_id=parent.id)
    f1 = await make_feature(session, "rank results", child.id, graph)
    f2 = await make_feature(session, "index corpus", child.id, graph)
    await feature_service.create_edge(
        session, EdgeCreate(src_id=f1.id, dst_id=f2.id, kind=EdgeKind.DEPENDS_ON), graph
    )
    session.add_all(
        [
            Motivation(goal_id=goal.id, capability_id=parent.id),
            ProductBundle(product_id=product.id, capability_id=parent.id),
            TechSatisfaction(tech_id=tech.id, capability_id=parent.id, fit=TechFit.native),
            Epic(product_id=product.id, capability_id=child.id, title="search epic"),
        ]
    )
    await session.commit()
    return {
        "goal": goal,
        "product": product,
        "parent": parent,
        "child": child,
        "f1": f1,
        "f2": f2,
    }


def ref(entity, row_id):
    return RowRef(entity=entity, id=row_id)


async def count(session, model):
    return await session.scalar(select(func.count()).select_from(model))


# --- closure -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_closure_pulls_the_whole_subtree_under_a_capability(db):
    async with db() as session:
        e = await seed_estate(session)
        to_delete, detach, missing = await admin_cascade.compute_closure(
            session, [ref("capabilities", e["parent"].id)]
        )

    assert missing == []
    # The SET-NULL stance: the child capability comes too, rather than being
    # silently re-rooted at top level by Postgres.
    assert to_delete[Capability] == {e["parent"].id, e["child"].id}
    assert to_delete[Feature] == {e["f1"].id, e["f2"].id}
    assert len(to_delete[FeatureEdge]) == 1
    assert len(to_delete[Motivation]) == 1
    assert len(to_delete[ProductBundle]) == 1
    assert len(to_delete[TechSatisfaction]) == 1
    # The epic outlives it — SET NULL, and it belongs to a surviving product.
    assert Epic not in to_delete
    assert detach[Epic] == 1


@pytest.mark.asyncio
async def test_overlapping_selections_are_deduplicated(db):
    async with db() as session:
        e = await seed_estate(session)
        to_delete, _, _ = await admin_cascade.compute_closure(
            session,
            [ref("capabilities", e["parent"].id), ref("features", e["f1"].id)],
        )
        assert to_delete[Feature] == {e["f1"].id, e["f2"].id}  # f1 counted once

        preview = await admin_cascade.preview(
            session,
            [ref("capabilities", e["parent"].id), ref("features", e["f1"].id)],
        )

    features_total = next(t.count for t in preview.total_deletes if t.table == "features")
    assert features_total == 2
    # f1's own row contributes only its edge and its link — the capability
    # already reached it.
    f1_row = next(r for r in preview.rows if r.id == e["f1"].id)
    assert sorted(t.table for t in f1_row.deletes) == ["feature_capabilities", "feature_edges"]


@pytest.mark.asyncio
async def test_closure_terminates_on_a_deep_subtree_and_mutual_edges(db):
    async with db() as session:
        a = await make_capability(session, "a")
        b = await make_capability(session, "b", parent_id=a.id)
        c = await make_capability(session, "c", parent_id=b.id)
        f1 = await make_feature(session, "f1", c.id)
        f2 = await make_feature(session, "f2", c.id)
        # Mutually referencing edges: the dedup is what stops this looping.
        await feature_service.create_edge(
            session, EdgeCreate(src_id=f1.id, dst_id=f2.id, kind=EdgeKind.DEPENDS_ON)
        )
        await feature_service.create_edge(
            session, EdgeCreate(src_id=f2.id, dst_id=f1.id, kind=EdgeKind.RELATES_TO)
        )
        to_delete, _, _ = await admin_cascade.compute_closure(
            session, [ref("capabilities", a.id)]
        )

    assert to_delete[Capability] == {a.id, b.id, c.id}
    assert len(to_delete[FeatureEdge]) == 2


@pytest.mark.asyncio
async def test_detach_counts_exclude_rows_that_are_themselves_deleted(db):
    async with db() as session:
        e = await seed_estate(session)
        epic = await session.scalar(select(Epic))
        session.add(Story(epic_id=epic.id, feature_id=e["f1"].id, title="a story"))
        await session.commit()

        # Deleting the product deletes the epic, so its story is deleted too —
        # it must not also be reported as detached.
        to_delete, detach, _ = await admin_cascade.compute_closure(
            session, [ref("products", e["product"].id)]
        )
        assert len(to_delete[Story]) == 1
        assert detach.get(Story, 0) == 0

        # Deleting the feature instead only unpins the story.
        _, detach2, _ = await admin_cascade.compute_closure(
            session, [ref("features", e["f1"].id)]
        )
        assert detach2[Story] == 1


@pytest.mark.asyncio
async def test_leaf_entities_can_be_seeded_directly(db):
    """The four join/leaf tabs have no CHILDREN entry — the closure must fall
    through and delete exactly what was selected. This is the most common real
    admin action on half the tabs."""
    async with db() as session:
        e = await seed_estate(session)
        edge = await session.scalar(select(FeatureEdge))
        motivation = await session.scalar(select(Motivation))
        bundle = await session.scalar(select(ProductBundle))
        ticket = Ticket(product_id=e["product"].id, title="a ticket")
        session.add(ticket)
        await session.commit()

        for entity, row in (
            ("feature_edges", edge),
            ("motivations", motivation),
            ("product_bundles", bundle),
            ("tickets", ticket),
        ):
            to_delete, _, _ = await admin_cascade.compute_closure(
                session, [ref(entity, row.id)]
            )
            assert to_delete == {type(row): {row.id}}, entity

        result = await admin_cascade.execute(
            session,
            [
                ref("feature_edges", edge.id),
                ref("motivations", motivation.id),
                ref("product_bundles", bundle.id),
                ref("tickets", ticket.id),
            ],
        )
        assert result.total == 4
        # Nothing else went with them.
        assert await count(session, Feature) == 2
        assert await count(session, Capability) == 2


# --- execution ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_cascade_removes_the_closure_and_spares_the_rest(db):
    async with db() as session:
        e = await seed_estate(session)
        result = await admin_cascade.execute(
            session, [ref("capabilities", e["parent"].id)]
        )

        assert await count(session, Capability) == 0
        assert await count(session, Feature) == 0
        assert await count(session, FeatureEdge) == 0
        assert await count(session, Motivation) == 0
        assert await count(session, ProductBundle) == 0
        assert await count(session, TechSatisfaction) == 0
        # Survivors, and the epic keeps its identity minus the pin.
        assert await count(session, Product) == 1
        assert await count(session, Goal) == 1
        epic = await session.scalar(select(Epic))
        assert epic is not None and epic.capability_id is None
        # 2 caps, 2 features, 1 edge, 1 motivation, 1 bundle, 1 tech satisfaction
        assert result.total == 10  # 8 rows + the two features' capability links


@pytest.mark.asyncio
async def test_cascade_beats_the_restrict_that_409s_today(db):
    async with db() as session:
        e = await seed_estate(session)
        # The guarded single-delete path refuses, twice over.
        with pytest.raises(HTTPException) as err:
            await capability_service.delete_capability(session, e["child"].id)
        assert err.value.status_code == 409
        assert "realize" in str(err.value.detail)

        await admin_cascade.execute(session, [ref("capabilities", e["child"].id)])
        # Query, not session.get: the sessionmaker sets expire_on_commit=False,
        # so the identity map still holds the row the database no longer has.
        survivor = await session.scalar(
            select(Capability.id).where(Capability.id == e["child"].id)
        )
        assert survivor is None
        assert await count(session, Feature) == 0


@pytest.mark.asyncio
async def test_one_missing_id_deletes_nothing(db):
    async with db() as session:
        e = await seed_estate(session)
        before = {
            m: await count(session, m)
            for m in (Capability, Feature, FeatureEdge, Motivation, ProductBundle,
                      TechSatisfaction, Product, Goal, Epic)
        }
        with pytest.raises(HTTPException) as err:
            await admin_cascade.execute(
                session,
                [ref("capabilities", e["parent"].id), ref("capabilities", uuid.uuid4())],
            )
        assert err.value.status_code == 404
        for model, n in before.items():
            assert await count(session, model) == n, model.__name__


@pytest.mark.asyncio
async def test_preview_and_delete_agree_exactly(db):
    async with db() as session:
        e = await seed_estate(session)
        rows = [ref("capabilities", e["parent"].id)]
        preview = await admin_cascade.preview(session, rows)
        result = await admin_cascade.execute(session, rows)

    assert [(t.table, t.count) for t in result.deleted] == [
        (t.table, t.count) for t in preview.total_deletes
    ]
    assert [(t.table, t.count) for t in result.detached] == [
        (t.table, t.count) for t in preview.total_detaches
    ]
    assert result.total == preview.total_rows


@pytest.mark.asyncio
async def test_preview_warns_about_subtree_and_buy_plane(db):
    async with db() as session:
        e = await seed_estate(session)
        preview = await admin_cascade.preview(session, [ref("capabilities", e["parent"].id)])

    assert any("descendant capabilities" in w for w in preview.warnings)
    assert any("buy plane" in w for w in preview.warnings)
    assert any(t.plane == "buy" and t.table == "tech_satisfactions" for t in preview.total_deletes)


@pytest.mark.asyncio
async def test_graph_marked_dirty_once_and_only_for_feature_rows(db):
    async with db() as session:
        e = await seed_estate(session)
        ticket = Ticket(product_id=e["product"].id, title="a ticket")
        session.add(ticket)
        await session.commit()

        graph = FeatureGraph(db)
        await graph.load()
        await admin_cascade.execute(session, [ref("tickets", ticket.id)], graph)
        assert graph._dirty is False  # no features in that closure

        await admin_cascade.execute(session, [ref("capabilities", e["parent"].id)], graph)
        assert graph._dirty is True
        await graph.ensure_fresh()
        assert graph.relationships(e["f1"].id) == {"outgoing": [], "incoming": []}


# --- registry / gates --------------------------------------------------------


@pytest.mark.asyncio
async def test_child_registry_matches_the_live_foreign_keys(db):
    """The registry is transcribed from pg_constraint, so it must not drift from
    it. Both directions, scoped to the parents the cascade knows about."""
    tables = {m.__tablename__: m for m in CHILDREN}
    async with db() as session:
        rows = (
            await session.execute(
                text(
                    "select c.confrelid::regclass::text parent, "
                    "c.conrelid::regclass::text child, a.attname col "
                    "from pg_constraint c "
                    "join unnest(c.conkey) k on true "
                    "join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k "
                    "where c.contype='f'"
                )
            )
        ).all()

    actual = {(p, c, col) for p, c, col in rows if p in tables}
    declared = {
        (parent.__tablename__, spec.model.__tablename__, spec.fk)
        for parent, specs in CHILDREN.items()
        for spec in specs
    }
    assert declared == actual


@pytest.mark.parametrize("surface", [Surface.api, Surface.mcp])
@pytest.mark.parametrize(
    "path", ["/api/admin/data/cascade-preview", "/api/admin/data/cascade-delete"]
)
def test_cascade_blocked_off_the_desktop_even_for_admin(surface, path):
    principal = Principal(sub="u", username="u", roles=["admin"], surface=surface)
    with pytest.raises(HTTPException) as err:
        authorize("POST", principal, path)
    assert err.value.status_code == 403
    assert err.value.detail["error"] == "human_action_required"


@pytest.mark.asyncio
async def test_cascade_requires_admin_not_merely_editor():
    editor = Principal(sub="u", username="u", roles=["editor"], surface=Surface.desktop)
    with pytest.raises(HTTPException) as err:
        await require_admin(editor)
    assert err.value.status_code == 403


# --- the new list endpoints --------------------------------------------------


@pytest.mark.asyncio
async def test_join_row_lists_expose_the_ids_nothing_else_does(db, client):
    async with db() as session:
        await seed_estate(session)

    motivations = (await client.get("/api/motivations")).json()
    bundles = (await client.get("/api/product-bundles")).json()

    assert len(motivations) == 1
    assert motivations[0]["goal_title"] == "ship the thing"
    assert motivations[0]["capability_name"] == "feature intelligence"
    uuid.UUID(motivations[0]["id"])  # the selection key
    assert len(bundles) == 1
    assert bundles[0]["product_name"] == "Metis"
    uuid.UUID(bundles[0]["id"])


@pytest.mark.asyncio
async def test_tickets_list_spans_products(db, client):
    async with db() as session:
        e = await seed_estate(session)
        other = Product(slug="other", name="Other")
        session.add(other)
        await session.commit()
        session.add_all(
            [
                Ticket(product_id=e["product"].id, title="one"),
                Ticket(product_id=other.id, title="two"),
            ]
        )
        await session.commit()

    tickets = (await client.get("/api/tickets")).json()
    assert {t["title"] for t in tickets} == {"one", "two"}


@pytest.mark.asyncio
async def test_cascade_endpoints_round_trip_over_http(db, client):
    async with db() as session:
        e = await seed_estate(session)

    body = {"rows": [{"entity": "capabilities", "id": str(e["parent"].id)}]}
    preview = (await client.post("/api/admin/data/cascade-preview", json=body)).json()
    assert preview["total_rows"] == 10
    assert preview["rows"][0]["label"] == "feature intelligence"

    result = (await client.post("/api/admin/data/cascade-delete", json=body)).json()
    assert result["total"] == 10

    async with db() as session:
        assert await count(session, Capability) == 0


@pytest.mark.asyncio
async def test_a_feature_still_realizing_something_survives_the_cascade(db):
    """Deleting one of a feature's capabilities removes the link, not the
    feature — it still realizes the other. A feature left realizing nothing
    goes with the closure, as it always did."""
    async with db() as session:
        shared = await make_capability(session, "Strava import")
        kept = await make_capability(session, "Elevation data")
        both = await feature_service.create_feature(
            session, FeatureCreate(name="ride summary", capability_ids=[shared.id, kept.id])
        )
        only = await make_feature(session, "sync rides", shared.id)

        to_delete, _, _ = await admin_cascade.compute_closure(
            session, [ref("capabilities", shared.id)]
        )
        assert to_delete[Feature] == {only.id}
        await admin_cascade.execute(session, [ref("capabilities", shared.id)])

    async with db() as session:
        survivor = await session.get(Feature, both.id)
        assert survivor is not None and survivor.capability_ids == [kept.id]
        assert await session.get(Feature, only.id) is None
