"""Which product each goal belongs to (services/goals.py), and the goals API
that carries it as product_id."""

import uuid

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import Goal, GoalType, Product
from app.services.goals import goal_owners


def owners_by_name(tree: dict[str, str | None], products: dict[str, str | None]) -> dict[str, str]:
    """goal_owners over names: tree maps goal -> parent, products maps
    product -> its goal."""
    ids = {name: uuid.uuid4() for name in [*tree, *products]}
    names = {v: k for k, v in ids.items()}
    owners = goal_owners(
        {ids[g]: ids[p] if p else None for g, p in tree.items()},
        [(ids[p], ids[g] if g else None) for p, g in products.items()],
    )
    return {names[g]: names[p] for g, p in owners.items()}


# The real portfolio's shapes: a product on its org goal, a product on one of
# its org goal's product goals, and someone else's products with no goal.
REAL_TREE = {
    "OG-39": None, "PG-40": "OG-39", "PG-41": "OG-39",
    "OG-48": None, "PG-49": "OG-48", "PG-50": "OG-48",
    "OG-60": None, "PG-61": "OG-60", "PG-62": "OG-60",
    "OG-63": None, "PG-64": "OG-63", "PG-65": "OG-63", "PG-66": "OG-63",
    "OG-67": None, "PG-68": "OG-67", "PG-69": "OG-67",
    "OG-80": None, "PG-81": "OG-80", "PG-82": "OG-80",
}
REAL_PRODUCTS = {
    "Taskmaster007": "OG-39",
    "App Builders PH": "OG-48",
    "Steps (iOS)": "PG-61",
    "Tagomoto": "PG-64",
    "Tagomoto Website": "PG-68",
    "Magpie": "PG-81",
    "Strava": None,
    "komoot": None,
    "Plausible Analytics": None,
}


def test_each_product_owns_its_whole_goal_tree():
    owners = owners_by_name(REAL_TREE, REAL_PRODUCTS)
    owned = lambda product: sorted(g for g, p in owners.items() if p == product)  # noqa: E731
    assert owned("Taskmaster007") == ["OG-39", "PG-40", "PG-41"]
    assert owned("App Builders PH") == ["OG-48", "PG-49", "PG-50"]
    # A product on a product goal owns its org goal and its siblings too.
    assert owned("Steps (iOS)") == ["OG-60", "PG-61", "PG-62"]
    assert owned("Magpie") == ["OG-80", "PG-81", "PG-82"]
    assert owned("Tagomoto") == ["OG-63", "PG-64", "PG-65", "PG-66"]
    assert owned("Tagomoto Website") == ["OG-67", "PG-68", "PG-69"]
    # Someone else's product with no goal owns nothing.
    for product in ("Strava", "komoot", "Plausible Analytics"):
        assert owned(product) == []
    assert set(owners) == set(REAL_TREE)


def test_an_org_goal_two_products_point_into_is_neither_ones():
    owners = owners_by_name(
        {"OG": None, "PG-app": "OG", "PG-site": "OG", "PG-loose": "OG"},
        {"App": "PG-app", "Site": "PG-site"},
    )
    assert owners == {"PG-app": "App", "PG-site": "Site"}


def test_another_product_pointing_in_later_takes_the_shared_goals_away():
    tree = {"Household": None, "Find items": "Household", "Keep current": "Household"}
    before = owners_by_name(tree, {"Tagomoto": "Find items", "Website": None})
    assert before == {"Household": "Tagomoto", "Find items": "Tagomoto", "Keep current": "Tagomoto"}
    after = owners_by_name(
        {**tree, "Visitors": "Household"}, {"Tagomoto": "Find items", "Website": "Visitors"}
    )
    assert after == {"Find items": "Tagomoto", "Visitors": "Website"}


def test_a_goal_two_products_both_point_at_is_neither_ones():
    owners = owners_by_name(
        {"OG": None, "PG": "OG"}, {"A": "OG", "B": "OG", "C": None}
    )
    assert owners == {}


def test_a_product_with_no_goal_owns_nothing():
    owners = owners_by_name({"OG": None, "PG": "OG"}, {"Ours": None, "Theirs": None})
    assert owners == {}


def test_a_product_owns_only_through_its_own_goal():
    """The pure rule: no goal_id, no goals. (owners() leaves external
    products out before it runs; see the API test.)"""
    owners = owners_by_name(
        {"OG-ours": None, "PG-ours": "OG-ours", "OG-theirs": None},
        {"Ours": "OG-ours", "Strava": None, "Rival": "OG-theirs"},
    )
    assert owners == {"OG-ours": "Ours", "PG-ours": "Ours", "OG-theirs": "Rival"}


def test_a_goal_under_another_products_goal_stays_that_products():
    owners = owners_by_name(
        {"OG": None, "PG-a": "OG", "PG-b": "OG"}, {"Top": "OG", "Inner": "PG-a"}
    )
    assert owners == {"OG": "Top", "PG-b": "Top", "PG-a": "Inner"}


def test_three_levels_deep_the_nearest_products_goal_decides():
    """Inner's climb reaches Middle, which also sits under Top's goal. Under
    Top's goal it stays Top's, except below Inner's own goal."""
    owners = owners_by_name(
        {"Top goal": None, "Middle": "Top goal", "Inner goal": "Middle", "Beside": "Middle"},
        {"Top": "Top goal", "Inner": "Inner goal"},
    )
    assert owners == {"Top goal": "Top", "Middle": "Top", "Beside": "Top", "Inner goal": "Inner"}


def test_a_parent_cycle_ends_the_climb():
    owners = owners_by_name({"A": "B", "B": "A", "C": None}, {"P": "C"})
    assert owners == {"C": "P"}


@pytest_asyncio.fixture
async def client(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, db


async def test_the_goals_api_says_whose_each_goal_is(client):
    http, db = client
    async with db() as s:
        org = Goal(goal_type=GoalType.org, title="Calm students")
        lone = Goal(goal_type=GoalType.org, title="Nobody's")
        s.add_all([org, lone])
        await s.flush()
        ship = Goal(goal_type=GoalType.product, title="Ship v1", parent_goal_id=org.id)
        verify = Goal(goal_type=GoalType.product, title="Verify", parent_goal_id=org.id)
        s.add_all([ship, verify])
        await s.flush()
        steps = Product(name="Steps", slug="steps", goal_id=ship.id)
        # Someone else's product pointing at our org goal takes nothing from Steps (A31).
        strava = Product(name="Strava", slug="strava", external=True, goal_id=org.id)
        s.add_all([steps, strava])
        await s.commit()
        ids = {g.title: str(g.id) for g in (org, lone, ship, verify)}
        steps_id = str(steps.id)

    rows = (await http.get("/api/goals")).json()
    assert {r["title"]: r["product_id"] for r in rows} == {
        "Calm students": steps_id, "Ship v1": steps_id, "Verify": steps_id, "Nobody's": None,
    }
    # Every field it had is still there.
    assert {"id", "display_id", "goal_type", "parent_goal_id", "title", "status"} <= set(rows[0])

    # The filter comes after the owners: a product goal still finds its owner.
    product_rows = (await http.get("/api/goals", params={"goal_type": "product"})).json()
    assert {r["product_id"] for r in product_rows} == {steps_id}

    one = (await http.get(f"/api/goals/{ids['Verify']}")).json()
    assert one["product_id"] == steps_id
    made = (await http.post(
        "/api/goals", json={"goal_type": "product", "title": "Widgets", "parent_goal_id": ids["Calm students"]}
    )).json()
    assert made["product_id"] == steps_id
    moved = (await http.patch(f"/api/goals/{made['id']}", json={"parent_goal_id": ids["Nobody's"]})).json()
    assert moved["product_id"] is None
