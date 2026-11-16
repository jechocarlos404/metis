"""Customer journeys: an ordered path of features, possibly across products,
scored against the inventory with the same rules as the product score."""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models import CapabilityMaturity, WorkStatus
from app.schemas.admin import RowRef
from app.schemas.feature import FeatureCreate
from app.schemas.journey import JourneyCreate, JourneyStepIn, JourneyUpdate
from app.services import admin_cascade
from app.services import features as feature_service
from app.services import journeys as journey_service
from tests.test_external import cap, product


async def world(session):
    route = await cap(session, "Route import", CapabilityMaturity.ga)
    weather = await cap(session, "Weather data", CapabilityMaturity.beta)
    segments = await cap(session, "Segment leaderboards")
    ours = await product(session, "Can I Climb")
    other = await product(session, "Saddlebag")
    strava = await product(session, "Strava", external=True)

    async def feature(name, prod, caps, status=WorkStatus.done, unknown=False):
        return await feature_service.create_feature(
            session,
            FeatureCreate(
                name=name,
                product_id=prod.id,
                capability_ids=[c.id for c in caps],
                status=status,
                unknown_capabilities=unknown,
            ),
        )

    return {
        "import": await feature("Import a route", ours, [route]),
        "forecast": await feature("See the weather on the climb", other, [weather, route]),
        "draft": await feature("Pace a route", ours, [route], status=WorkStatus.in_progress),
        "segments": await feature("Compete on segments", strava, [segments]),
        "kudos": await feature("Give kudos", strava, [route], unknown=True),
        "ours": ours,
        "other": other,
        "strava": strava,
    }


def step(feature=None, **kw):
    return JourneyStepIn(feature_id=feature.id if feature else None, **kw)


@pytest.mark.asyncio
async def test_a_journey_across_products_scores_each_step(db):
    async with db() as session:
        w = await world(session)
        j = await journey_service.create_journey(
            session,
            JourneyCreate(
                name="Plan a Saturday climb",
                persona="a rider new to the hills",
                steps=[
                    step(w["import"]),
                    step(w["forecast"]),
                    step(w["draft"]),
                    step(w["segments"]),
                    step(w["kudos"]),
                    step(label="Book a bike fit", needs=["Bike Fit Booking"]),
                    step(label="Ride with friends"),
                ],
            ),
        )
        assert [s.label for s in j.steps][:2] == ["Import a route", "See the weather on the climb"]
        a = await journey_service.analyze(session, j.id)

    verdicts = [s.verdict for s in a.steps]
    assert verdicts == [
        "buildable",
        "buildable",
        "buildable",
        "missing",  # segments: only Strava (external) has it
        "known_covered",  # kudos: what's named is ours, but the list is incomplete
        "missing",  # nobody has bike-fit booking
        "unknown",  # nothing named
    ]
    # Live = a user can do it today in one of ours: done and ours.
    assert [s.live for s in a.steps] == [True, True, False, False, False, False, False]
    assert a.live == 2
    assert [p.name for p in a.products] == ["Can I Climb", "Saddlebag"]
    assert [p.name for p in a.external_products] == ["Strava"]
    assert a.counts == {"buildable": 3, "known_covered": 1, "missing": 2, "unknown": 1}
    assert "Bike Fit Booking" in a.report.missing
    assert a.steps[3].coverage.capabilities[0].match.ours is False


@pytest.mark.asyncio
async def test_steps_are_scored_by_position_not_by_name(db):
    async with db() as session:
        w = await world(session)
        j = await journey_service.create_journey(
            session,
            JourneyCreate(
                name="Same name twice",
                steps=[
                    step(label="Check", needs=["Route import"]),
                    step(label="Empty"),
                    step(label="Check", needs=["Segment leaderboards"]),
                    step(w["import"]),
                ],
            ),
        )
        a = await journey_service.analyze(session, j.id)
    assert [s.verdict for s in a.steps] == ["buildable", "unknown", "missing", "buildable"]
    assert a.steps[1].coverage is None
    assert a.steps[2].coverage.capabilities[0].name == "Segment leaderboards"


@pytest.mark.asyncio
async def test_deleting_a_feature_leaves_a_labelled_gap(db):
    async with db() as session:
        w = await world(session)
        j = await journey_service.create_journey(
            session,
            JourneyCreate(name="Gap", steps=[step(w["import"]), step(w["forecast"])]),
        )
        import_id, forecast_id, journey_id = w["import"].id, w["forecast"].id, j.id
        # One by the normal path, one by the admin cascade.
        await feature_service.delete_feature(session, import_id)
        await admin_cascade.execute(session, [RowRef(entity="features", id=forecast_id)])
        session.expire_all()
        a = await journey_service.analyze(session, journey_id)
    assert [s.label for s in a.steps] == ["Import a route", "See the weather on the climb"]
    assert [s.feature for s in a.steps] == [None, None]
    assert [s.verdict for s in a.steps] == ["unknown", "unknown"]


@pytest.mark.asyncio
async def test_editing_replaces_the_path_and_filters_by_feature(db):
    async with db() as session:
        w = await world(session)
        j = await journey_service.create_journey(
            session, JourneyCreate(name="Edit me", steps=[step(w["import"])])
        )
        other = await journey_service.create_journey(
            session, JourneyCreate(name="Other", steps=[step(w["forecast"])])
        )
        j = await journey_service.update_journey(
            session,
            j.id,
            JourneyUpdate(name="Edited", steps=[step(w["forecast"]), step(w["import"], label="Bring a GPX")]),
        )
        assert j.name == "Edited"
        assert [(s.position, s.label) for s in j.steps] == [
            (0, "See the weather on the climb"),
            (1, "Bring a GPX"),
        ]
        through_import = await journey_service.list_journeys(session, w["import"].id)
        through_forecast = await journey_service.list_journeys(session, w["forecast"].id)
        assert [x.name for x in through_import] == ["Edited"]
        assert {x.name for x in through_forecast} == {"Edited", "Other"}

        await journey_service.delete_journey(session, other.id)
        with pytest.raises(HTTPException):
            await journey_service.get_journey(session, other.id)


@pytest.mark.asyncio
async def test_invalid_steps_are_refused(db):
    with pytest.raises(ValidationError):
        JourneyStepIn(label="  ")
    async with db() as session:
        import uuid

        with pytest.raises(HTTPException) as err:
            await journey_service.create_journey(
                session, JourneyCreate(name="x", steps=[JourneyStepIn(feature_id=uuid.uuid4())])
            )
        assert err.value.status_code == 404
