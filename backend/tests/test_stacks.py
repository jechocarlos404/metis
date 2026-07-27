"""Stack service tests — the three predicates (gap, redundancy, drift), the
archetype/instance split, and the guards that keep a slot honest."""

import pytest
from fastapi import HTTPException

from app.models import AdoptionStatus, Product, TechFit, TechKind
from app.schemas.capability import CapabilityCreate
from app.schemas.governance import ConcernAnswerWrite, ConcernCreate
from app.schemas.stack import (
    ProductTechnologyWrite,
    SlotCreate,
    SlotUpdate,
    StackCreate,
    StackUpdate,
)
from app.schemas.technology import AdoptionWrite, SatisfactionCreate, TechnologyCreate
from app.services import capabilities as capability_service
from app.services import governance as governance_service
from app.services import stacks as stack_service
from app.services import technologies as tech_service


async def make_product(session, name="metis"):
    product = Product(slug=name, name=name)
    session.add(product)
    await session.commit()
    await session.refresh(product)
    return product


async def make_capability(session, name, product=None):
    capability = await capability_service.create_capability(
        session, CapabilityCreate(name=name)
    )
    if product is not None:
        await capability_service.bundle_product(session, product.id, capability.id)
    return capability


async def make_tech(session, slug, capability=None, fit=TechFit.native):
    technology = await tech_service.create_technology(
        session, TechnologyCreate(slug=slug, name=slug, kind=TechKind.service)
    )
    if capability is not None:
        await tech_service.create_satisfaction(
            session,
            SatisfactionCreate(
                tech_id=technology.id, capability_id=capability.id, fit=fit
            ),
        )
    return technology


def flags(view, role):
    return next(s.flags for s in view["slots"] if s.role == role)


@pytest.mark.asyncio
async def test_required_unfilled_slot_is_a_gap_and_stays_one(db):
    """Invariant 5: a gap round-trips and is never auto-filled. Nothing in the
    service fills a slot — binding is a human action."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        await make_tech(session, "postgres", capability)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )

        view = await stack_service.view(session, stack.id)
        assert flags(view, "primary store") == ["gap"]
        # an offer exists, and the gap survives reading it
        assert len(await tech_service.offers(session, capability.id)) == 1
        assert flags(await stack_service.view(session, stack.id), "primary store") == ["gap"]

        # an optional slot with nothing bound is not a gap, just unfilled
        await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="ops", role="tracing", required=False, position=1),
        )
        assert flags(await stack_service.view(session, stack.id), "tracing") == []


@pytest.mark.asyncio
async def test_unbinding_reopens_the_gap(db):
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        postgres = await make_tech(session, "postgres", capability)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )

        await stack_service.bind_slot(session, slot.id, postgres.id)
        assert flags(await stack_service.view(session, stack.id), "primary store") == []

        await stack_service.bind_slot(session, slot.id, None)
        assert flags(await stack_service.view(session, stack.id), "primary store") == ["gap"]


@pytest.mark.asyncio
async def test_binding_requires_a_recorded_satisfaction(db):
    """A binding claims the technology answers the slot's capability. If nobody
    has said so with a fit, the claim has no basis."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "vector index", product)
        unrelated = await make_tech(session, "nginx")
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="vector index", capability_id=capability.id),
        )
        with pytest.raises(HTTPException) as err:
            await stack_service.bind_slot(session, slot.id, unrelated.id)
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_two_slots_on_one_capability_is_redundancy(db):
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "http api", product)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="api", role="public api", capability_id=capability.id),
        )
        await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(
                layer="api", role="admin api", capability_id=capability.id, position=1
            ),
        )
        view = await stack_service.view(session, stack.id)
        assert all("redundant" in s.flags for s in view["slots"])


@pytest.mark.asyncio
async def test_undeclared_usage_is_drift(db):
    """Invariant: via_slot_id NULL is the whole drift detector. The first drift
    report is a deliverable, not a defect."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        postgres = await make_tech(session, "postgres", capability)
        redis = await make_tech(session, "redis")
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
            session,
            product.id,
            ProductTechnologyWrite(tech_id=postgres.id, via_slot_id=slot.id),
        )
        await stack_service.record_usage(
            session, product.id, ProductTechnologyWrite(tech_id=redis.id)
        )

        assert [d.slug for d in await stack_service.drift(session, product.id)] == ["redis"]
        view = await stack_service.view(session, stack.id)
        assert [d.slug for d in view["drift"]] == ["redis"]

        # declaring it through a slot closes the drift
        await stack_service.record_usage(
            session,
            product.id,
            ProductTechnologyWrite(tech_id=redis.id, via_slot_id=slot.id),
        )
        assert await stack_service.drift(session, product.id) == []


@pytest.mark.asyncio
async def test_workaround_and_trial_bindings_are_flagged(db):
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "semantic search", product)
        fts = await make_tech(session, "postgres-fts", capability, TechFit.workaround)
        await tech_service.set_adoption(
            session, fts.id, AdoptionWrite(status=AdoptionStatus.trial)
        )
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="search", capability_id=capability.id),
        )
        await stack_service.bind_slot(session, slot.id, fts.id)
        assert set(flags(await stack_service.view(session, stack.id), "search")) == {
            "workaround",
            "trial",
        }


@pytest.mark.asyncio
async def test_slot_capability_must_be_bundled_by_the_product(db):
    """Invariant 6, enforced in the service because no cross-table FK expresses
    it. Archetypes are exempt: they have no product to check against."""
    async with db() as session:
        product = await make_product(session)
        unbundled = await capability_service.create_capability(
            session, CapabilityCreate(name="billing")
        )
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        with pytest.raises(HTTPException) as err:
            await stack_service.create_slot(
                session,
                stack.id,
                SlotCreate(layer="api", role="payments", capability_id=unbundled.id),
            )
        assert err.value.status_code == 422

        archetype = await stack_service.create_stack(
            session, StackCreate(name="service archetype", is_archetype=True)
        )
        slot = await stack_service.create_slot(
            session,
            archetype.id,
            SlotCreate(layer="api", role="payments", capability_id=unbundled.id),
        )
        assert slot.capability_id == unbundled.id

        # bundling it makes the product slot legal
        await capability_service.bundle_product(session, product.id, unbundled.id)
        ok = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="api", role="payments", capability_id=unbundled.id),
        )
        await stack_service.update_slot(session, ok.id, SlotUpdate(role="payments api"))


@pytest.mark.asyncio
async def test_repointing_a_stack_revalidates_its_slots(db):
    """Invariant 6 again: re-pointing carries the slots with it, so the new
    product has to bundle everything they answer."""
    async with db() as session:
        origin = await make_product(session, "metis")
        other = await make_product(session, "atlas")
        capability = await make_capability(session, "durable persistence", origin)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=origin.id)
        )
        await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )

        with pytest.raises(HTTPException) as err:
            await stack_service.update_stack(
                session, stack.id, StackUpdate(product_id=other.id)
            )
        assert err.value.status_code == 422

        await capability_service.bundle_product(session, other.id, capability.id)
        moved = await stack_service.update_stack(
            session, stack.id, StackUpdate(product_id=other.id)
        )
        assert moved.product_id == other.id


@pytest.mark.asyncio
async def test_archetype_belongs_to_no_product(db):
    async with db() as session:
        product = await make_product(session)
        with pytest.raises(HTTPException) as err:
            await stack_service.create_stack(
                session,
                StackCreate(name="bad", is_archetype=True, product_id=product.id),
            )
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_instantiating_copies_shape_not_bindings(db):
    """An archetype and an instance are the same object at two levels of
    binding. Instantiating carries the shape; every slot lands unfilled."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        postgres = await make_tech(session, "postgres", capability)
        archetype = await stack_service.create_stack(
            session, StackCreate(name="service archetype", is_archetype=True)
        )
        source = await stack_service.create_slot(
            session,
            archetype.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )
        await stack_service.bind_slot(session, source.id, postgres.id)

        instance = await stack_service.instantiate(
            session, archetype.id, product.id, "metis stack"
        )
        assert instance.parent_id == archetype.id and instance.product_id == product.id
        slots = await stack_service.list_slots(session, instance.id)
        assert len(slots) == 1
        assert slots[0].capability_id == capability.id
        assert slots[0].tech_id is None  # a binding is a decision, not an inheritance

        summary = await stack_service.summarize(session, archetype)
        assert summary["instances"] == 1

        with pytest.raises(HTTPException) as err:
            await stack_service.instantiate(session, instance.id, product.id, "again")
        assert err.value.status_code == 422


@pytest.mark.asyncio
async def test_redundancy_ignores_workaround_overlap(db):
    """Question 4. Postgres full-text is not competing with a vector store, and
    reporting it as duplication would make the whole report noise."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "semantic search", product)
        qdrant = await make_tech(session, "qdrant", capability, TechFit.native)
        pgvector = await make_tech(session, "pgvector", capability, TechFit.partial)
        fts = await make_tech(session, "postgres-fts", capability, TechFit.workaround)

        for technology in (qdrant, fts):
            await stack_service.record_usage(
                session, product.id, ProductTechnologyWrite(tech_id=technology.id)
            )
        assert await stack_service.redundancy(session) == []

        await stack_service.record_usage(
            session, product.id, ProductTechnologyWrite(tech_id=pgvector.id)
        )
        findings = await stack_service.redundancy(session)
        assert len(findings) == 1
        assert findings[0].competing == ["pgvector", "qdrant"]


@pytest.mark.asyncio
async def test_unanswered_concerns_are_reported(db):
    """An unmet capability is a roadmap item; an unanswered concern is a
    review blocker."""
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )
        auth = await governance_service.create_concern(session, ConcernCreate(name="auth"))
        await governance_service.create_concern(
            session, ConcernCreate(name="observability")
        )

        assert await stack_service.unanswered_concerns(session, stack.id) == [
            "auth",
            "observability",
        ]
        await stack_service.answer_concern(
            session, stack.id, ConcernAnswerWrite(concern_id=auth.id, slot_id=slot.id)
        )
        assert await stack_service.unanswered_concerns(session, stack.id) == [
            "observability"
        ]

        # an answer that names no slot does not count as answered
        await stack_service.answer_concern(
            session, stack.id, ConcernAnswerWrite(concern_id=auth.id, slot_id=None)
        )
        assert await stack_service.unanswered_concerns(session, stack.id) == [
            "auth",
            "observability",
        ]


@pytest.mark.asyncio
async def test_bound_technology_cannot_be_deleted(db):
    async with db() as session:
        product = await make_product(session)
        capability = await make_capability(session, "durable persistence", product)
        postgres = await make_tech(session, "postgres", capability)
        stack = await stack_service.create_stack(
            session, StackCreate(name="metis stack", product_id=product.id)
        )
        slot = await stack_service.create_slot(
            session,
            stack.id,
            SlotCreate(layer="data", role="primary store", capability_id=capability.id),
        )
        await stack_service.bind_slot(session, slot.id, postgres.id)
        with pytest.raises(HTTPException) as err:
            await tech_service.delete_technology(session, postgres.id)
        assert err.value.status_code == 409
