import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.feature import (
    EdgeCreate,
    EdgeRead,
    FeatureCreate,
    FeatureDetail,
    FeatureRead,
    FeatureUpdate,
)
from app.services import features as feature_service
from app.services import search as search_service

router = APIRouter(prefix="/api/features", tags=["features"])


def get_graph(request: Request):
    return getattr(request.app.state, "graph", None)


@router.get("", response_model=list[FeatureRead])
async def list_features(
    q: str | None = None, session: AsyncSession = Depends(get_db)
):
    return await feature_service.list_features(session, q)


# NB: static routes must be registered before /{feature_id}.
@router.get("/search", response_model=list[FeatureRead])
async def search(
    q: str = Query(min_length=1), limit: int = 20, session: AsyncSession = Depends(get_db)
):
    return await search_service.search_features(session, q, limit)


@router.get("/edges", response_model=list[EdgeRead])
async def list_edges(session: AsyncSession = Depends(get_db)):
    return await feature_service.list_edges(session)


@router.post("/edges", response_model=EdgeRead, status_code=201)
async def create_edge(
    data: EdgeCreate, request: Request, session: AsyncSession = Depends(get_db)
):
    return await feature_service.create_edge(session, data, get_graph(request))


@router.delete("/edges/{edge_id}", status_code=204)
async def delete_edge(
    edge_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
):
    await feature_service.delete_edge(session, edge_id, get_graph(request))


@router.post("", response_model=FeatureRead, status_code=201)
async def create_feature(
    data: FeatureCreate, request: Request, session: AsyncSession = Depends(get_db)
):
    return await feature_service.create_feature(session, data, get_graph(request))


@router.get("/{feature_id}", response_model=FeatureDetail)
async def get_feature(
    feature_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
):
    feature = await feature_service.get_feature(session, feature_id)
    detail = FeatureDetail.model_validate(feature)
    graph = get_graph(request)
    if graph is not None:
        rels = graph.relationships(feature_id)
        detail.outgoing = rels["outgoing"]
        detail.incoming = rels["incoming"]
    return detail


@router.patch("/{feature_id}", response_model=FeatureRead)
async def update_feature(
    feature_id: uuid.UUID,
    data: FeatureUpdate,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    return await feature_service.update_feature(session, feature_id, data, get_graph(request))


@router.delete("/{feature_id}", status_code=204)
async def delete_feature(
    feature_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
):
    await feature_service.delete_feature(session, feature_id, get_graph(request))
