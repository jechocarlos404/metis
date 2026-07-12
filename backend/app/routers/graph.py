import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.services import capabilities as capability_service
from app.services.graph_service import FeatureGraph, GraphCycleError

router = APIRouter(prefix="/api/graph", tags=["graph"])


class MVPCutRequest(BaseModel):
    features: list[uuid.UUID] = []
    capabilities: list[uuid.UUID] = []


async def _graph(request: Request) -> FeatureGraph:
    graph = getattr(request.app.state, "graph", None)
    if graph is None:
        raise HTTPException(503, "Graph not initialized")
    await graph.ensure_fresh()
    return graph


@router.get("/layout")
async def layout(request: Request):
    return (await _graph(request)).layout()


@router.get("/impact/{feature_id}")
async def impact(feature_id: uuid.UUID, request: Request):
    graph = await _graph(request)
    return {"feature_id": str(feature_id), **graph.impact(feature_id)}


@router.get("/topo")
async def topo(request: Request):
    graph = await _graph(request)
    try:
        return {"order": graph.topo_order()}
    except GraphCycleError as e:
        raise HTTPException(
            409,
            {
                "message": "Dependency cycle detected — break it before ordering.",
                "cycle": [str(n) for n in e.cycle],
            },
        ) from None


@router.get("/cycles")
async def cycles(request: Request):
    return {"cycles": (await _graph(request)).find_cycles()}


@router.get("/ready")
async def ready(request: Request):
    """The work frontier: pending features whose dependencies are all done."""
    return {"ready": (await _graph(request)).ready_set()}


@router.post("/mvp-cut")
async def mvp_cut(
    data: MVPCutRequest, request: Request, session: AsyncSession = Depends(get_db)
):
    """Prerequisite closure for a delivery cut: essential = targets plus
    everything they transitively need (dependencies first); deferrable =
    everything else (hottest priority first). Capability targets expand to
    their scope."""
    graph = await _graph(request)
    try:
        return await capability_service.mvp_cut(
            session, graph, data.features, data.capabilities
        )
    except GraphCycleError as e:
        raise HTTPException(
            409,
            {
                "message": "Dependency cycle detected — break it before cutting scope.",
                "cycle": [str(n) for n in e.cycle],
            },
        ) from None


@router.post("/refresh")
async def refresh(request: Request):
    graph = getattr(request.app.state, "graph", None)
    if graph is None:
        raise HTTPException(503, "Graph not initialized")
    await graph.load()
    return {"status": "reloaded", "nodes": graph.node_count(), "edges": graph.edge_count()}
