import uuid
from types import SimpleNamespace

import pytest

from app.services.graph_service import FeatureGraph, GraphCycleError

CAP_A = uuid.uuid4()
CAP_B = uuid.uuid4()


def fake_feature(seq: int, name: str, **kw):
    return SimpleNamespace(
        id=uuid.uuid4(),
        seq=seq,
        name=name,
        capability_id=kw.get("capability_id", CAP_A),
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


def test_capability_coupling_projection():
    """Feature precedence projects onto capabilities; internal edges drop."""
    graph = FeatureGraph(sessionmaker=None)
    search = fake_feature(1, "search", capability_id=CAP_A)
    index = fake_feature(2, "index", capability_id=CAP_A)
    export = fake_feature(3, "export", capability_id=CAP_B)
    for f in (search, index, export):
        graph.upsert_node(f)
    graph.add_edge(search.id, index.id, "DEPENDS_ON")  # internal to CAP_A
    graph.add_edge(export.id, search.id, "DEPENDS_ON")  # crosses capabilities

    assert graph.coupling_edges() == {(CAP_B, CAP_A)}
    impact = graph.capability_impact({CAP_A})
    assert impact["dependents"] == [CAP_B]
    assert impact["dependencies"] == []
    impact = graph.capability_impact({CAP_B})
    assert impact["dependents"] == []
    assert impact["dependencies"] == [CAP_A]
