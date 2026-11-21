import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import Principal, current_user
from app.auth.deps import author
from app.db import get_db
from app.models import Feature, Goal, Product
from app.schemas.capability import MAX_NAME, CapabilityRead, ProductCoverage
from app.schemas.product import (
    DecompositionCreate,
    DecompositionRead,
    ProductBundleCreate,
    ProductBundleRead,
    ProductCreate,
    ProductRead,
    ProductUpdate,
)
from app.services import capabilities as capability_service
from app.services import features as feature_service
from app.services.slugs import unique_slug
from app.services import decomposition as decomposition_service

router = APIRouter(prefix="/api", tags=["products"])


@router.get("/products", response_model=list[ProductRead])
async def list_products(
    near: str | None = Query(None, max_length=MAX_NAME), session: AsyncSession = Depends(get_db)
):
    """Every product. With `near`, only those whose name is near it (three at
    most, nearest first): candidates after an exact miss, never a match."""
    if near is not None:
        return (await capability_service.near_names(session, Product, [near]))[near]
    return (await session.scalars(select(Product).order_by(Product.seq))).all()


@router.post("/products", response_model=ProductRead, status_code=201)
async def create_product(data: ProductCreate, session: AsyncSession = Depends(get_db)):
    if data.goal_id is not None and await session.get(Goal, data.goal_id) is None:
        raise HTTPException(404, "Goal not found")
    fields = data.model_dump()
    fields["slug"] = await unique_slug(session, Product, data.name, data.slug)
    product = Product(**fields)
    session.add(product)
    await session.commit()
    await session.refresh(product)
    return product


@router.get("/products/{product_id}", response_model=ProductRead)
async def get_product(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await decomposition_service.get_product(session, product_id)


@router.get("/products/{product_id}/coverage", response_model=ProductCoverage)
async def product_coverage(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    """How much of this product we could build from what we already have."""
    return await capability_service.product_coverage(session, product_id)


@router.patch("/products/{product_id}", response_model=ProductRead)
async def update_product(
    product_id: uuid.UUID,
    data: ProductUpdate,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    product = await decomposition_service.get_product(session, product_id)
    updates = data.model_dump(exclude_unset=True)
    if updates.get("external") is None:
        updates.pop("external", None)
    flipped = "external" in updates and updates["external"] != product.external
    for key, value in updates.items():
        setattr(product, key, value)
    if {"name", "summary", "body"} & updates.keys():
        product.version = product.version + 1
    await session.commit()
    await session.refresh(product)
    if flipped:
        # Whether its features are our work just changed.
        await feature_service.refresh_product_features(
            session, product.id, getattr(request.app.state, "graph", None)
        )
    return product


@router.delete("/products/{product_id}", status_code=204)
async def delete_product(
    product_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
):
    """Its features go with it. The foreign key alone would detach them, and a
    feature with no product counts as ours."""
    product = await decomposition_service.get_product(session, product_id)
    owned = Feature.product_id == product_id
    feature_ids = (await session.scalars(select(Feature.id).where(owned))).all()
    await session.execute(delete(Feature).where(owned))
    await session.delete(product)
    await session.commit()
    graph = getattr(request.app.state, "graph", None)
    if graph is not None:
        for feature_id in feature_ids:
            graph.remove_node(feature_id)


@router.post("/products/{product_id}/seeded", response_model=ProductRead)
async def mark_seeded(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    """The seed loaders call this after an import: the product's map was just
    refreshed. The time is the server's; a caller never supplies one."""
    product = await decomposition_service.get_product(session, product_id)
    product.seeded_at = func.now()
    await session.commit()
    await session.refresh(product)
    return product


@router.post("/products/{product_id}/approve", response_model=ProductRead)
async def approve_product(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await decomposition_service.approve_product(session, product_id)


@router.get("/products/{product_id}/bundles", response_model=list[CapabilityRead])
async def list_bundles(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await capability_service.bundled_capabilities(session, product_id)


@router.post(
    "/products/{product_id}/bundles",
    response_model=ProductBundleRead,
    status_code=201,
)
async def create_bundle(
    product_id: uuid.UUID,
    data: ProductBundleCreate,
    session: AsyncSession = Depends(get_db),
):
    return await capability_service.bundle_product(session, product_id, data.capability_id)


@router.delete(
    "/products/{product_id}/bundles/{capability_id}",
    status_code=204,
)
async def delete_bundle(
    product_id: uuid.UUID,
    capability_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
):
    await capability_service.unbundle_product(session, product_id, capability_id)


@router.get("/products/{product_id}/decompositions", response_model=list[DecompositionRead])
async def list_decompositions(
    product_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    return await decomposition_service.list_decompositions(session, product_id)


@router.post(
    "/products/{product_id}/decompositions",
    response_model=DecompositionRead,
    status_code=201,
)
async def create_decomposition(
    product_id: uuid.UUID,
    data: DecompositionCreate,
    session: AsyncSession = Depends(get_db),
    principal: Principal = Depends(current_user),
):
    return await decomposition_service.create_prd_draft(
        session, product_id, data.document, author(principal, data.created_by)
    )


@router.post("/decompositions/{decomposition_id}/approve", response_model=DecompositionRead)
async def approve_decomposition(
    decomposition_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    return await decomposition_service.approve_decomposition(session, decomposition_id)
