"""Recheck: if a feature changes, what else must be rechecked or retested.

breaks follow the precedence graph (links of links); retest, broad and
elsewhere cross the bridge through confirmed capabilities only.
"""

import uuid
from types import SimpleNamespace

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.db import get_db
from app.main import create_app
from app.models import CapabilityGuess, Confidence, Product
from app.schemas.capability import CapabilityCreate
from app.schemas.feature import FeatureCreate
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.graph_service import FeatureGraph

P = uuid.uuid4()


def graph_of(*features):
    graph = FeatureGraph(sessionmaker=None)
    for f in features:
        graph.upsert_node(f)
    return graph


def feat(name, caps=(), product=P, external=False):
    feat.seq += 1
    return SimpleNamespace(
        id=uuid.uuid4(), seq=feat.seq, name=name, capability_ids=tuple(caps),
        product_id=product, external=external, facets={}, status="pending", priority=None,
    )


feat.seq = 0


def names(rows):
    return [r["name"] for r in rows]


def test_breaks_follow_links_of_links_nearest_first():
    """protocol <- jira <- exporter, and protocol BLOCKS report (report needs
    protocol). jira also shares protocol's capability: it breaks, so it is
    not listed again under retest."""
    cap = uuid.uuid4()
    protocol, jira, exporter, report = (
        feat("protocol", [cap]), feat("jira", [cap]), feat("exporter"), feat("report")
    )
    graph = graph_of(protocol, jira, exporter, report)
    graph.add_edge(jira.id, protocol.id, "DEPENDS_ON")
    graph.add_edge(exporter.id, jira.id, "DEPENDS_ON")
    graph.add_edge(protocol.id, report.id, "BLOCKS")

    result = graph.recheck(protocol.id, {cap: "Sync"}, {})
    assert result["feature"]["name"] == "protocol"
    assert [(b["name"], b["direct"], b["via"]) for b in result["breaks"]] == [
        ("jira", True, []),
        ("report", True, []),
        ("exporter", False, ["jira"]),
    ]
    assert result["retest"] == []
    # Nothing depends on exporter.
    assert graph.recheck(exporter.id, {}, {})["breaks"] == []


def test_a_rare_shared_capability_ranks_first():
    rare, common = uuid.uuid4(), uuid.uuid4()
    target = feat("target", [rare, common])
    partner = feat("partner", [rare])
    crowd = [feat(f"crowd {i}", [common]) for i in range(3)]
    both = feat("both", [rare, common])
    filler = [feat(f"filler {i}") for i in range(5)]
    graph = graph_of(target, partner, both, *crowd, *filler)

    result = graph.recheck(target.id, {rare: "Rare", common: "Common"}, {})
    # rare: target, partner, both = 3 users; common: target, both, 3 crowd = 5.
    assert names(result["retest"]) == ["both", "partner", "crowd 0", "crowd 1", "crowd 2"]
    top = result["retest"][0]
    assert top["shared"] == [{"id": str(rare), "name": "Rare"}, {"id": str(common), "name": "Common"}]
    assert top["score"] == round(1 / 3 + 1 / 5, 4)
    assert result["retest"][1]["score"] == round(1 / 3, 4)
    assert result["retest"][2]["score"] == round(1 / 5, 4)
    assert result["broad"] == []


def test_broad_capabilities_collapse_to_a_count():
    """12 features: one capability used by 7 (more than half, at least 6) is
    broad; one used by exactly 6 (half, not more) is still listed."""
    big, half, rare = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    target = feat("target", [big, half, rare])
    only_big = [feat(f"big {i}", [big]) for i in range(6)]
    only_half = [feat(f"half {i}", [half]) for i in range(5)]
    graph = graph_of(target, *only_big, *only_half)

    result = graph.recheck(target.id, {big: "Login", half: "Audit", rare: "Rare"}, {})
    # The count is the number the rule judged: 7 features use Login.
    assert result["broad"] == [{"id": str(big), "name": "Login", "features": 7}]
    # Sharing only a broad capability means appearing only in the count.
    assert names(result["retest"]) == [f"half {i}" for i in range(5)]
    assert all(r["shared"] == [{"id": str(half), "name": "Audit"}] for r in result["retest"])


def test_broad_count_keeps_features_listed_under_breaks():
    """The audit's case: most features that share the admin console also need
    the sign-in feature, so they show under breaks. The broad count still
    says how many use it (at least 6), not the 2 left over."""
    console = uuid.uuid4()
    target = feat("sign in", [console])
    needers = [feat(f"admin page {i}", [console]) for i in range(10)]
    others = [feat(f"other {i}", [console]) for i in range(2)]
    plain = [feat(f"public page {i}", []) for i in range(8)]
    graph = graph_of(target, *needers, *others, *plain)
    for n in needers:
        graph.add_edge(n.id, target.id, "DEPENDS_ON")

    result = graph.recheck(target.id, {console: "Admin Console"}, {})
    assert len(result["breaks"]) == 10
    assert result["broad"] == [{"id": str(console), "name": "Admin Console", "features": 13}]
    assert result["retest"] == []


def test_a_small_product_never_has_broad_capabilities():
    """All five use it, but fewer than six features is not broad."""
    cap = uuid.uuid4()
    target = feat("target", [cap])
    rest = [feat(f"peer {i}", [cap]) for i in range(4)]
    result = graph_of(target, *rest).recheck(target.id, {cap: "Login"}, {})
    assert result["broad"] == []
    assert len(result["retest"]) == 4


def test_elsewhere_groups_our_other_products_and_skips_external():
    a, b = uuid.uuid4(), uuid.uuid4()
    ours, other, rival = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    target = feat("target", [a, b], product=ours)
    graph = graph_of(
        target,
        feat("other 1", [a], product=other),
        feat("other 2", [a, b], product=other),
        feat("rival 1", [a], product=rival, external=True),
        feat("loose", [a], product=None),
    )
    result = graph.recheck(target.id, {a: "Login", b: "Billing"}, {other: "Other app"})
    assert result["elsewhere"] == [
        {"id": str(other), "name": "Other app", "capabilities": ["Billing", "Login"], "features": 2}
    ]
    assert result["retest"] == []


def test_an_external_feature_still_gets_its_own_product():
    cap = uuid.uuid4()
    rival = uuid.uuid4()
    target = feat("rival a", [cap], product=rival, external=True)
    peer = feat("rival b", [cap], product=rival, external=True)
    result = graph_of(target, peer).recheck(target.id, {cap: "Login"}, {})
    assert names(result["retest"]) == ["rival b"]


def test_a_feature_without_capabilities_has_nothing_to_retest():
    cap = uuid.uuid4()
    target = feat("unknown", [])
    graph = graph_of(target, feat("peer", [cap]), feat("there", [cap], product=uuid.uuid4()))
    result = graph.recheck(target.id, {cap: "Login"}, {})
    assert (result["retest"], result["broad"], result["elsewhere"]) == ([], [], [])


def test_unknown_feature_is_none():
    assert graph_of().recheck(uuid.uuid4(), {}, {}) is None


# ---- the route, on the database ----


@pytest_asyncio.fixture
async def client(db):
    app = create_app()

    async def _session():
        async with db() as session:
            yield session

    app.dependency_overrides[get_db] = _session
    app.dependency_overrides[get_settings] = lambda: Settings(auth_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield app, db, http


async def test_route_ignores_guesses_and_404s_unknown(client):
    app, db, http = client
    async with db() as s:
        login = await capability_service.create_capability(s, CapabilityCreate(name="Login"))
        audit = await capability_service.create_capability(s, CapabilityCreate(name="Audit"))
        product = Product(name="App", slug="app")
        s.add(product)
        await s.commit()

        def make(name, caps, **kw):
            return feature_service.create_feature(
                s, FeatureCreate(name=name, product_id=product.id, capability_ids=caps, **kw)
            )

        target = await make("Sign in", [login.id])
        confirmed = await make("Sign out", [login.id])
        guessed = await make("Reset password", [], unknown_capabilities=True)
        audited = await make("Audit trail", [audit.id])
        # A guess is not a link, in either direction.
        s.add_all([
            CapabilityGuess(capability_id=login.id, feature_id=guessed.id, confidence=Confidence.high),
            CapabilityGuess(capability_id=audit.id, feature_id=target.id, confidence=Confidence.high),
        ])
        await s.commit()
    graph = FeatureGraph(db)
    await graph.load()
    app.state.graph = graph

    res = await http.get(f"/api/graph/recheck/{target.id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [r["id"] for r in body["retest"]] == [str(confirmed.id)]
    assert body["retest"][0]["shared"] == [{"id": str(login.id), "name": "Login"}]
    assert str(audited.id) not in res.text
    assert (body["breaks"], body["broad"], body["elsewhere"]) == ([], [], [])

    assert (await http.get(f"/api/graph/recheck/{uuid.uuid4()}")).status_code == 404
