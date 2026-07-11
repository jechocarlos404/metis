import uuid
from types import SimpleNamespace

import pytest

from app.services.graph_service import FeatureGraph, GraphCycleError


def fake_feature(seq: int, name: str, **kw):
    return SimpleNamespace(
        id=uuid.uuid4(),
        seq=seq,
        name=name,
        type=kw.get("type", "capability"),
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


def test_non_depends_edges_ignored_by_impact(chain):
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
