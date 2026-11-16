"""Buy-plane service tests — the catalog's neutrality, the SATISFIES hinge,
tech-edge acyclicity, and the three questions computed rather than stored."""

import uuid
from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from app.models import (
    Adoption,
    AdoptionStatus,
    EncounterDepth,
    Feature,
    FeatureCapability,
    Product,
    ProductTechnology,
    StackSlot,
    TechEdgeKind,
    TechFit,
    TechKind,
    TechSatisfaction,
    TechStack,
    Technology,
    VendorKind,
)
from app.schemas.capability import CapabilityCreate
from app.schemas.governance import ConstraintCreate, ScopeWrite
from app.schemas.stack import ProductTechnologyWrite, SlotCreate, StackCreate
from app.schemas.technology import (
    AdoptionWrite,
    EncounterCreate,
    SatisfactionCreate,
    TechEdgeCreate,
    TechnologyCreate,
    TechnologyUpdate,
    VendorCreate,
    VersionCreate,
)
from app.services import capabilities as capability_service
from app.services import governance as governance_service
from app.services import stacks as stack_service
from app.services import technologies as tech_service


async def make_tech(session, slug, kind=TechKind.service, layer=None, facets=None):
    return await tech_service.create_technology(
        session,
        TechnologyCreate(
            slug=slug, name=slug, kind=kind, layer=layer, facets=facets or {}
        ),
    )


async def make_capability(session, name):
    return await capability_service.create_capability(session, CapabilityCreate(name=name))


async def satisfy(session, tech, capability, fit=TechFit.native, cost=None):
    return await tech_service.create_satisfaction(
        session,
        SatisfactionCreate(
            tech_id=tech.id, capability_id=capability.id, fit=fit, cost=cost or {}
        ),
    )


@pytest.mark.asyncio
async def test_catalog_carries_no_opinion(db):
    """Invariant 2: technologies has no column whose value depends on who is
    asking. The stance lives in its own table, and its absence is meaningful."""
    async with db() as session:
        columns = set(Technology.__table__.columns.keys())
        assert not columns & {"status", "adoption", "owner", "stance", "rationale"}

        technology = await make_tech(session, "qdrant")
        page = await tech_service.catalog(session)
        assert page["rows"][0]["adoption"] is None

        await tech_service.set_adoption(
            session, technology.id, AdoptionWrite(status=AdoptionStatus.trial)
        )
        page = await tech_service.catalog(session)
        assert page["rows"][0]["adoption"] == AdoptionStatus.trial

        # Withdrawing a stance is not a demotion — the row goes away entirely.
        await tech_service.clear_adoption(session, technology.id)
        assert await tech_service.get_adoption(session, technology.id) is None


@pytest.mark.asyncio
async def test_catalog_facets_and_pagination(db):
    async with db() as session:
        await make_tech(session, "postgres", TechKind.service, "data")
        await make_tech(session, "fastapi", TechKind.framework, "api")
        typescript = await make_tech(session, "typescript", TechKind.language, None)
        await tech_service.set_adoption(
            session, typescript.id, AdoptionWrite(status=AdoptionStatus.standard)
        )

        page = await tech_service.catalog(session, kind="framework")
        assert [r["technology"].slug for r in page["rows"]] == ["fastapi"]
        # facet counts for the active facet ignore that facet's own filter
        assert page["facet_counts"]["kind"] == {"service": 1, "framework": 1, "language": 1}
        # a language spans layers: NULL layer is honest, not a gap to fill
        assert page["facet_counts"]["layer"] == {"api": 1}

        page = await tech_service.catalog(session, adoption="none")
        assert {r["technology"].slug for r in page["rows"]} == {"postgres", "fastapi"}

        page = await tech_service.catalog(session, limit=2, offset=2)
        assert page["total"] == 3 and len(page["rows"]) == 1

        # search matches slug or name, case-insensitively
        page = await tech_service.catalog(session, q="POST")
        assert [r["technology"].slug for r in page["rows"]] == ["postgres"]

        with pytest.raises(HTTPException) as err:
            await tech_service.catalog(session, kind="nonsense")
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_satisfaction_is_many_to_many(db):
    """Invariant 1's counterpart: a feature realizes exactly one capability, a
    technology serves several. That asymmetry is the whole point of the hinge."""
    async with db() as session:
        postgres = await make_tech(session, "postgres")
        durable = await make_capability(session, "durable persistence")
        search = await make_capability(session, "semantic search")
        await satisfy(session, postgres, durable, TechFit.native)
        await satisfy(session, postgres, search, TechFit.workaround)

        assert len(await tech_service.list_satisfactions(session, tech_id=postgres.id)) == 2
        with pytest.raises(HTTPException) as err:
            await satisfy(session, postgres, durable)
        assert err.value.status_code == 409


@pytest.mark.asyncio
async def test_capability_with_supply_cannot_be_deleted(db):
    """Invariant: tech_satisfactions.capability_id is RESTRICT, mirroring the
    feature FK — a capability with supply cannot vanish under a stack."""
    async with db() as session:
        qdrant = await make_tech(session, "qdrant")
        capability = await make_capability(session, "vector index")
        await satisfy(session, qdrant, capability)

        with pytest.raises(HTTPException) as err:
            await capability_service.delete_capability(session, capability.id)
        assert err.value.status_code == 409


@pytest.mark.asyncio
async def test_requires_and_runs_on_are_jointly_acyclic(db):
    """Invariant 3. The cycle check spans both kinds together; ALTERNATIVE_TO
    is symmetric by design and never participates."""
    async with db() as session:
        app_ = await make_tech(session, "metis-api")
        runtime = await make_tech(session, "python")
        host = await make_tech(session, "kubernetes")

        await tech_service.create_edge(
            session, TechEdgeCreate(src_id=app_.id, dst_id=runtime.id, kind=TechEdgeKind.REQUIRES)
        )
        await tech_service.create_edge(
            session, TechEdgeCreate(src_id=runtime.id, dst_id=host.id, kind=TechEdgeKind.RUNS_ON)
        )

        with pytest.raises(HTTPException) as err:
            await tech_service.create_edge(
                session,
                TechEdgeCreate(src_id=host.id, dst_id=app_.id, kind=TechEdgeKind.REQUIRES),
            )
        assert err.value.status_code == 422

        # symmetric and annotation kinds are exempt — write both directions
        await tech_service.create_edge(
            session,
            TechEdgeCreate(src_id=host.id, dst_id=app_.id, kind=TechEdgeKind.ALTERNATIVE_TO),
        )
        await tech_service.create_edge(
            session,
            TechEdgeCreate(src_id=app_.id, dst_id=host.id, kind=TechEdgeKind.ALTERNATIVE_TO),
        )
        assert len(await tech_service.list_edges(session)) == 4


@pytest.mark.asyncio
async def test_self_edge_rejected(db):
    async with db() as session:
        technology = await make_tech(session, "redis")
        with pytest.raises(HTTPException) as err:
            await tech_service.create_edge(
                session, TechEdgeCreate(src_id=technology.id, dst_id=technology.id)
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_dependents_separate_breaks_from_drift(db):
    """Question 2. required is a break, optional an inconvenience, and
    off_stack means nobody declared the dependency in the first place."""
    async with db() as session:
        product = Product(slug="metis", name="metis")
        session.add(product)
        await session.commit()
        capability = await make_capability(session, "durable persistence")
        await capability_service.bundle_product(session, product.id, capability.id)
        postgres = await make_tech(session, "postgres")
        redis = await make_tech(session, "redis")
        await satisfy(session, postgres, capability)

        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )
        await stack_service.bind_slot(session, slot.id, postgres.id)
        await stack_service.record_usage(
            session, product.id, ProductTechnologyWrite(tech_id=postgres.id, via_slot_id=slot.id)
        )
        await stack_service.record_usage(
            session, product.id, ProductTechnologyWrite(tech_id=redis.id)
        )

        declared = await tech_service.dependents(session, postgres.id)
        assert [(b.required, b.off_stack, b.role) for b in declared] == [
            (True, False, "primary store")
        ]
        undeclared = await tech_service.dependents(session, redis.id)
        assert [(b.required, b.off_stack) for b in undeclared] == [(False, True)]


@pytest.mark.asyncio
async def test_exposure_modes_are_independent(db):
    """Question 3. Each death mode stands alone: a deprecated stance surfaces
    with no version rows at all, and a bus factor of one surfaces regardless of
    stance. Nothing is stored — the view is recomputed per call."""
    async with db() as session:
        dying = await make_tech(session, "neo4j")
        await tech_service.create_version(
            session,
            dying.id,
            VersionCreate(label="4", eol_on=date.today() + timedelta(days=30)),
        )

        given_up = await make_tech(session, "bolt-driver")
        await tech_service.set_adoption(
            session, given_up.id, AdoptionWrite(status=AdoptionStatus.deprecated)
        )

        lone = await tech_service.create_vendor(
            session, VendorCreate(name="one maintainer", kind=VendorKind.individual, bus_factor=1)
        )
        fragile = await make_tech(session, "left-pad")
        await tech_service.update_technology(
            session, fragile.id, TechnologyUpdate(vendor_id=lone.id)
        )

        healthy = await make_tech(session, "postgres")
        await tech_service.create_version(
            session,
            healthy.id,
            VersionCreate(label="17", eol_on=date.today() + timedelta(days=2000)),
        )

        findings = {f.slug: f.reasons for f in await tech_service.exposure(session)}
        assert findings == {
            "neo4j": ["eol"],
            "bolt-driver": ["stance"],
            "left-pad": ["bus_factor"],
        }


@pytest.mark.asyncio
async def test_offers_are_ranked_not_scored(db):
    """Question 1 and steps 3-5 of the recommendation. Ordering is fit, then
    stance, then experience, then ops burden, then slug — every key computed."""
    async with db() as session:
        capability = await make_capability(session, "semantic search")
        pgvector = await make_tech(session, "pgvector")
        qdrant = await make_tech(session, "qdrant")
        fts = await make_tech(session, "postgres-fts")

        await satisfy(session, qdrant, capability, TechFit.native, {"ops_burden": 3})
        await satisfy(session, pgvector, capability, TechFit.native, {"ops_burden": 1})
        await satisfy(session, fts, capability, TechFit.workaround)

        offers = await tech_service.offers(session, capability.id)
        # both native; neither has a stance; ops burden breaks the tie
        assert [o.slug for o in offers] == ["pgvector", "qdrant", "postgres-fts"]
        assert [o.rank for o in offers] == [1, 2, 3]

        # a stance outranks ops burden — it is the group's existing bet
        await tech_service.set_adoption(
            session, qdrant.id, AdoptionWrite(status=AdoptionStatus.adopted)
        )
        assert [o.slug for o in await tech_service.offers(session, capability.id)][0] == "qdrant"

        # ...and fit outranks the stance: correctness before convenience
        await tech_service.set_adoption(
            session, fts.id, AdoptionWrite(status=AdoptionStatus.standard)
        )
        assert [o.slug for o in await tech_service.offers(session, capability.id)][-1] == (
            "postgres-fts"
        )


@pytest.mark.asyncio
async def test_offer_with_no_stance_is_still_an_offer(db):
    """The LEFT join is how the world catalog earns its keep."""
    async with db() as session:
        capability = await make_capability(session, "http api")
        unknown = await make_tech(session, "litestar")
        await satisfy(session, unknown, capability)
        offers = await tech_service.offers(session, capability.id)
        assert len(offers) == 1 and offers[0].stance is None


@pytest.mark.asyncio
async def test_blocking_constraint_prunes_before_fit(db):
    async with db() as session:
        capability = await make_capability(session, "graph store")
        agpl = await make_tech(session, "neo4j", facets={"license": "AGPL-3.0"})
        permissive = await make_tech(session, "apache-age", facets={"license": "Apache-2.0"})
        await satisfy(session, agpl, capability, TechFit.native)
        await satisfy(session, permissive, capability, TechFit.partial)

        constraint = await governance_service.create_constraint(
            session,
            ConstraintCreate(
                name="CON-001 no AGPL",
                kind="license",
                expression={"field": "license", "not_in": ["AGPL-3.0"]},
            ),
        )
        await governance_service.add_scope(session, constraint.id, ScopeWrite())

        offers = await tech_service.offers(session, capability.id)
        # native fit does not save a blocked candidate — the prune runs first
        assert [o.slug for o in offers] == ["apache-age"]

        await tech_service.delete_satisfaction(
            session,
            (await tech_service.list_satisfactions(session, tech_id=permissive.id))[0].id,
        )
        assert await tech_service.offers(session, capability.id) == []
        assert await tech_service.blocked_reason(session, capability.id) == ["CON-001 no AGPL"]


@pytest.mark.asyncio
async def test_warn_constraint_annotates_without_pruning(db):
    async with db() as session:
        capability = await make_capability(session, "object storage")
        technology = await make_tech(session, "s3", facets={"residency": "us"})
        await satisfy(session, technology, capability)
        constraint = await governance_service.create_constraint(
            session,
            ConstraintCreate(
                name="CON-002 prefer eu",
                kind="residency",
                expression={"field": "residency", "not_in": ["us"]},
                severity="warn",
            ),
        )
        await governance_service.add_scope(session, constraint.id, ScopeWrite())

        offers = await tech_service.offers(session, capability.id)
        assert len(offers) == 1 and offers[0].warned_by == ["CON-002 prefer eu"]


@pytest.mark.asyncio
async def test_encounters_answer_who_to_ask(db):
    """Question 5. Deliberately thin: who, how deep, how recently."""
    async with db() as session:
        technology = await make_tech(session, "terraform")
        for person, depth, when in (
            ("ana", EncounterDepth.evaluated, date(2024, 1, 1)),
            ("bo", EncounterDepth.shipped, date(2023, 6, 1)),
            ("cy", EncounterDepth.touched, date(2025, 1, 1)),
        ):
            await tech_service.create_encounter(
                session,
                EncounterCreate(
                    tech_id=technology.id, person=person, depth=depth, last_at=when
                ),
            )
        rows = await tech_service.list_encounters(session, technology.id)
        assert [e.person for e in rows] == ["bo", "cy", "ana"]

        # experience feeds the ranking, deepest wins
        capability = await make_capability(session, "infrastructure as code")
        await satisfy(session, technology, capability)
        offers = await tech_service.offers(session, capability.id)
        assert offers[0].experience == EncounterDepth.shipped


@pytest.mark.asyncio
async def test_slug_is_canonical_and_unique(db):
    async with db() as session:
        await make_tech(session, "apache-age")
        with pytest.raises(HTTPException) as err:
            await make_tech(session, "apache-age")
        assert err.value.status_code == 409


@pytest.mark.asyncio
async def test_build_plane_realizes_through_the_link_table(db):
    """Invariant 1: a feature REALIZES capabilities only through
    feature_capabilities, whose capability FK is RESTRICT like the buy side's."""
    assert "capability_id" not in Feature.__table__.c
    (fk,) = FeatureCapability.__table__.c.capability_id.foreign_keys
    assert fk.ondelete == "RESTRICT"


@pytest.mark.asyncio
async def test_nothing_derived_is_stored(db):
    """Invariant 7: no stored score anywhere. Exposure, ranking and redundancy
    are consequences of the graph, not facts about it — storing them guarantees
    they go stale, which is the trap the mirrored graph already sprang."""
    buy_plane = [
        Technology,
        TechSatisfaction,
        Adoption,
        TechStack,
        StackSlot,
        ProductTechnology,
    ]
    for model in buy_plane:
        columns = set(model.__table__.columns.keys())
        assert not columns & {"score", "risk", "rank", "exposure", "redundancy"}


@pytest.mark.asyncio
async def test_missing_technology_is_404(db):
    async with db() as session:
        with pytest.raises(HTTPException) as err:
            await tech_service.get_technology(session, uuid.uuid4())
        assert err.value.status_code == 404
