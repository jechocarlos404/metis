import uuid
from types import SimpleNamespace

import pytest

from app.services.graph_service import FeatureGraph, GraphCycleError

CAP_A = uuid.uuid4()
CAP_B = uuid.uuid4()
CAP_C = uuid.uuid4()


def fake_feature(seq: int, name: str, **kw):
    return SimpleNamespace(
        id=uuid.uuid4(),
        seq=seq,
        name=name,
        capability_ids=kw.get("capability_ids", (kw.get("capability_id", CAP_A),)),
        product_id=kw.get("product_id"),
        external=kw.get("external", False),
        facets=kw.get("facets", {"layer": "service"}),
        status=kw.get("status", "pending"),
        priority=kw.get("priority"),
    )


@pytest.fixture
def chain():
    """protocol <- jira <- exporter   (A DEPENDS_ON B == A needs B)"""
    graph = FeatureGraph(sessionmaker=None)
    protocol = fake_feature(1, "protocol")
    jira = fake_feature(2, "jira")
    exporter = fake_feature(3, "exporter")
    for f in (protocol, jira, exporter):
        graph.upsert_node(f)
    graph.add_edge(jira.id, protocol.id, "DEPENDS_ON")
    graph.add_edge(exporter.id, jira.id, "DEPENDS_ON")
    return graph, protocol, jira, exporter


def test_impact_direction(chain):
    graph, protocol, jira, exporter = chain
    result = graph.impact(protocol.id)
    dependents = {d["name"] for d in result["dependents"]}
    assert dependents == {"jira", "exporter"}  # both break if protocol changes
    assert result["dependencies"] == []  # protocol needs nothing

    result = graph.impact(exporter.id)
    assert result["dependents"] == []
    assert {d["name"] for d in result["dependencies"]} == {"protocol", "jira"}


def test_blocks_feeds_precedence(chain):
    """A BLOCKS B == B needs A: BLOCKS edges must shape impact and ordering."""
    graph, protocol, jira, exporter = chain
    migration = fake_feature(4, "migration")
    graph.upsert_node(migration)
    graph.add_edge(migration.id, exporter.id, "BLOCKS")  # exporter waits for migration
    result = graph.impact(migration.id)
    assert {d["name"] for d in result["dependents"]} == {"exporter"}
    order = [n["name"] for n in graph.topo_order()]
    assert order.index("migration") < order.index("exporter")


def test_topo_order_dependencies_first(chain):
    graph, protocol, jira, exporter = chain
    order = [n["name"] for n in graph.topo_order()]
    assert order.index("protocol") < order.index("jira") < order.index("exporter")


def test_cycle_detection(chain):
    graph, protocol, jira, exporter = chain
    graph.add_edge(protocol.id, exporter.id, "DEPENDS_ON")  # close the loop
    with pytest.raises(GraphCycleError):
        graph.topo_order()
    cycles = graph.find_cycles()
    assert len(cycles) == 1
    assert {n["name"] for n in cycles[0]} == {"protocol", "jira", "exporter"}


def test_would_create_cycle_guard(chain):
    graph, protocol, jira, exporter = chain
    # protocol DEPENDS_ON exporter would close the loop
    assert graph.would_create_cycle(protocol.id, exporter.id, "DEPENDS_ON")
    # exporter BLOCKS protocol == protocol needs exporter: same loop
    assert graph.would_create_cycle(exporter.id, protocol.id, "BLOCKS")
    # the safe directions do not trip the guard
    assert not graph.would_create_cycle(exporter.id, protocol.id, "DEPENDS_ON")
    # RELATES_TO participates in nothing
    assert not graph.would_create_cycle(protocol.id, exporter.id, "RELATES_TO")


def test_ready_set(chain):
    graph, protocol, jira, exporter = chain
    # nothing done yet: only the dependency-free node is ready
    assert {n["name"] for n in graph.ready_set()} == {"protocol"}
    done = fake_feature(1, "protocol", status="done")
    done.id = protocol.id
    graph.upsert_node(done)
    assert {n["name"] for n in graph.ready_set()} == {"jira"}


def test_layout_columns(chain):
    graph, protocol, jira, exporter = chain
    layout = graph.layout()
    x = {n["name"]: n["x"] for n in layout["nodes"]}
    assert x["protocol"] < x["jira"] < x["exporter"]  # dependencies leftmost
    assert len(layout["edges"]) == 2


def test_layout_survives_cycle(chain):
    graph, protocol, jira, exporter = chain
    graph.add_edge(protocol.id, exporter.id, "DEPENDS_ON")
    layout = graph.layout()  # condensation collapses the SCC; must not raise
    assert len(layout["nodes"]) == 3


def test_relates_to_ignored_by_impact(chain):
    graph, protocol, jira, exporter = chain
    ui = fake_feature(4, "ui")
    graph.upsert_node(ui)
    graph.add_edge(ui.id, protocol.id, "RELATES_TO")
    assert all(d["name"] != "ui" for d in graph.impact(protocol.id)["dependents"])


def test_remove_node_and_edge(chain):
    graph, protocol, jira, exporter = chain
    graph.remove_edge(exporter.id, jira.id, "DEPENDS_ON")
    assert graph.impact(protocol.id)["dependents"] != []
    graph.remove_node(jira.id)
    assert graph.impact(protocol.id)["dependents"] == []
    assert graph.node_count() == 2


def test_relationships(chain):
    graph, protocol, jira, exporter = chain
    rels = graph.relationships(jira.id)
    assert [r["feature"]["name"] for r in rels["outgoing"]] == ["protocol"]
    assert [r["feature"]["name"] for r in rels["incoming"]] == ["exporter"]
    assert rels["outgoing"][0]["kind"] == "DEPENDS_ON"


def test_mvp_cut_closure(chain):
    """Essential = target + transitive prerequisites, dependencies first;
    deferrable = everything outside the closure."""
    graph, protocol, jira, exporter = chain
    cut = graph.mvp_cut({jira.id})
    assert [n["name"] for n in cut["essential"]] == ["protocol", "jira"]
    assert [n["is_target"] for n in cut["essential"]] == [False, True]
    assert [n["name"] for n in cut["deferrable"]] == ["exporter"]

    # targeting the tip pulls in the whole chain — nothing deferrable
    cut = graph.mvp_cut({exporter.id})
    assert [n["name"] for n in cut["essential"]] == ["protocol", "jira", "exporter"]
    assert cut["deferrable"] == []


def test_mvp_cut_deferrable_ranked_by_priority(chain):
    graph, protocol, jira, exporter = chain
    extra = fake_feature(4, "extra", priority=1)
    graph.upsert_node(extra)
    cut = graph.mvp_cut({protocol.id})
    assert [n["name"] for n in cut["deferrable"]] == ["extra", "jira", "exporter"]


def test_mvp_cut_capability_counts():
    graph = FeatureGraph(sessionmaker=None)
    search = fake_feature(1, "search", capability_id=CAP_A)
    index = fake_feature(2, "index", capability_id=CAP_A)
    export = fake_feature(3, "export", capability_id=CAP_B)
    for f in (search, index, export):
        graph.upsert_node(f)
    graph.add_edge(search.id, index.id, "DEPENDS_ON")
    graph.add_edge(export.id, search.id, "DEPENDS_ON")

    cut = graph.mvp_cut({export.id})
    assert cut["capabilities"][CAP_A] == {"required": 2, "total": 2}
    assert cut["capabilities"][CAP_B] == {"required": 1, "total": 1}

    cut = graph.mvp_cut({index.id})
    assert cut["capabilities"][CAP_A] == {"required": 1, "total": 2}
    assert cut["capabilities"][CAP_B] == {"required": 0, "total": 1}


def test_capability_impact_follows_feature_needs():
    """A feature need between capabilities shows on both sides; needs inside one capability don't."""
    graph = FeatureGraph(sessionmaker=None)
    search = fake_feature(1, "search", capability_id=CAP_A)
    index = fake_feature(2, "index", capability_id=CAP_A)
    export = fake_feature(3, "export", capability_id=CAP_B)
    for f in (search, index, export):
        graph.upsert_node(f)
    graph.add_edge(search.id, index.id, "DEPENDS_ON")  # internal to CAP_A
    graph.add_edge(export.id, search.id, "DEPENDS_ON")  # crosses capabilities

    impact = graph.capability_impact({CAP_A})
    assert impact["dependents"] == [CAP_B]
    assert impact["dependencies"] == []
    impact = graph.capability_impact({CAP_B})
    assert impact["dependents"] == []
    assert impact["dependencies"] == [CAP_A]


def test_capability_impact_counts_every_capability_of_a_needing_feature():
    """A feature realizing two capabilities makes both depend on what it needs."""
    graph = FeatureGraph(sessionmaker=None)
    summary = fake_feature(1, "ride summary", capability_ids=(CAP_A, CAP_B))
    importer = fake_feature(2, "import rides", capability_id=CAP_C)
    for f in (summary, importer):
        graph.upsert_node(f)
    graph.add_edge(summary.id, importer.id, "DEPENDS_ON")
    assert set(graph.capability_impact({CAP_C})["dependents"]) == {CAP_A, CAP_B}
    assert set(graph.capability_impact({CAP_A})["dependencies"]) == {CAP_C}


def test_capability_impact_never_bridges_products_through_a_shared_capability():
    """The audit's path: a cafe app and a planning tool both use File Storage.
    Projected onto capability pairs, Cafe Directory -> File Storage -> LLM ->
    Knowledge Graph made the cafe app "need" the knowledge graph. No cafe
    feature needs a knowledge-graph feature, so only LLM depends on it."""
    cafe_dir, files, llm, kg = (uuid.uuid4() for _ in range(4))
    cafes, planner = uuid.uuid4(), uuid.uuid4()
    graph = FeatureGraph(sessionmaker=None)
    new_cafe = fake_feature(1, "log a cup at a new cafe", capability_id=cafe_dir, product_id=cafes)
    photos = fake_feature(2, "log a cup with photos", capability_id=files, product_id=cafes)
    attach = fake_feature(3, "attach documents", capability_id=files, product_id=planner)
    threads = fake_feature(4, "conversation threads", capability_id=llm, product_id=planner)
    prereqs = fake_feature(5, "suggest prerequisites", capability_id=llm, product_id=planner)
    skills = fake_feature(6, "organize skills", capability_id=kg, product_id=planner)
    for f in (new_cafe, photos, attach, threads, prereqs, skills):
        graph.upsert_node(f)
    graph.add_edge(new_cafe.id, photos.id, "DEPENDS_ON")
    graph.add_edge(attach.id, threads.id, "DEPENDS_ON")
    graph.add_edge(prereqs.id, skills.id, "DEPENDS_ON")

    assert graph.capability_impact({kg}) == {"dependents": [llm], "dependencies": []}
    assert graph.capability_impact({cafe_dir}) == {"dependents": [], "dependencies": [files]}


def test_capability_impact_follows_links_of_links_including_its_own_features():
    """A feature of the capability that needs another one of its features
    brings its other capabilities along, and so does whatever needs it."""
    cap_d = uuid.uuid4()
    graph = FeatureGraph(sessionmaker=None)
    base = fake_feature(1, "store the graph", capability_id=CAP_A)
    linker = fake_feature(2, "link features", capability_ids=(CAP_A, CAP_B))
    search = fake_feature(3, "search links", capability_id=CAP_C)
    report = fake_feature(4, "report on links", capability_id=cap_d)
    loose = fake_feature(5, "unrelated", capability_id=uuid.uuid4())
    for f in (base, linker, search, report, loose):
        graph.upsert_node(f)
    graph.add_edge(linker.id, base.id, "DEPENDS_ON")
    graph.add_edge(linker.id, search.id, "BLOCKS")  # search needs linker
    graph.add_edge(report.id, search.id, "DEPENDS_ON")

    assert set(graph.capability_impact({CAP_A})["dependents"]) == {CAP_B, CAP_C, cap_d}
    assert graph.capability_impact({cap_d})["dependencies"] == sorted({CAP_A, CAP_B, CAP_C}, key=str)


def test_layout_carries_the_features_own_product():
    product_id = uuid.uuid4()
    graph = FeatureGraph(sessionmaker=None)
    graph.upsert_node(fake_feature(1, "owned", product_id=product_id))
    graph.upsert_node(fake_feature(2, "unowned"))
    nodes = {n["name"]: n for n in graph.layout()["nodes"]}
    assert nodes["owned"]["product_id"] == str(product_id)
    assert nodes["unowned"]["product_id"] is None


def test_layout_wraps_tall_columns_and_keeps_dependencies_left():
    graph = FeatureGraph(sessionmaker=None)
    loose = [fake_feature(i, f"loose{i}") for i in range(30)]
    base = fake_feature(100, "base")
    top = fake_feature(101, "top")
    for f in (*loose, base, top):
        graph.upsert_node(f)
    graph.add_edge(top.id, base.id, "DEPENDS_ON")
    nodes = {n["name"]: n for n in graph.layout()["nodes"]}
    xs = {n["x"] for n in nodes.values()}
    ys = {n["y"] for n in nodes.values()}
    assert len(xs) > 2  # 31 dependency-free features no longer share one column
    assert len(ys) < 31
    assert nodes["top"]["x"] > nodes["base"]["x"]
    assert len({(n["x"], n["y"]) for n in nodes.values()}) == len(nodes)


def test_layout_separates_products_into_blocks():
    graph = FeatureGraph(sessionmaker=None)
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    a = [fake_feature(i, f"a{i}", product_id=p1) for i in range(6)]
    b = [fake_feature(10 + i, f"b{i}", product_id=p2) for i in range(6)]
    for f in (*a, *b):
        graph.upsert_node(f)
    nodes = graph.layout()["nodes"]

    def box(pid):
        pts = [(n["x"], n["y"]) for n in nodes if n["product_id"] == str(pid)]
        return min(x for x, _ in pts), max(x for x, _ in pts), min(y for _, y in pts), max(y for _, y in pts)

    (ax0, ax1, ay0, ay1), (bx0, bx1, by0, by1) = box(p1), box(p2)
    assert ax1 < bx0 or bx1 < ax0 or ay1 < by0 or by1 < ay0  # bounding boxes don't overlap
