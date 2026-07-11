import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Goal, Product
from app.schemas.product import (
    DecompositionCreate,
    DecompositionRead,
    ProductCreate,
    ProductRead,
    ProductUpdate,
)
from app.services import decomposition as decomposition_service

router = APIRouter(prefix="/api", tags=["products"])


@router.get("/products", response_model=list[ProductRead])
async def list_products(session: AsyncSession = Depends(get_db)):
    return (await session.scalars(select(Product).order_by(Product.seq))).all()


@router.post("/products", response_model=ProductRead, status_code=201)
async def create_product(data: ProductCreate, session: AsyncSession = Depends(get_db)):
    if data.goal_id is not None and await session.get(Goal, data.goal_id) is None:
        raise HTTPException(404, "Goal not found")
    product = Product(**data.model_dump())
    session.add(product)
    await session.commit()
    await session.refresh(product)
    return product


@router.get("/products/{product_id}", response_model=ProductRead)
async def get_product(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await decomposition_service.get_product(session, product_id)


@router.patch("/products/{product_id}", response_model=ProductRead)
async def update_product(
    product_id: uuid.UUID, data: ProductUpdate, session: AsyncSession = Depends(get_db)
):
    product = await decomposition_service.get_product(session, product_id)
    updates = data.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(product, key, value)
    if {"name", "summary", "body"} & updates.keys():
        product.version = product.version + 1
    await session.commit()
    await session.refresh(product)
    return product


@router.delete("/products/{product_id}", status_code=204)
async def delete_product(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    product = await decomposition_service.get_product(session, product_id)
    await session.delete(product)
    await session.commit()


@router.post("/products/{product_id}/approve", response_model=ProductRead)
async def approve_product(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await decomposition_service.approve_product(session, product_id)


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
):
    return await decomposition_service.create_prd_draft(
        session, product_id, data.document, data.created_by
    )


@router.post("/decompositions/{decomposition_id}/approve", response_model=DecompositionRead)
async def approve_decomposition(
    decomposition_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    return await decomposition_service.approve_decomposition(session, decomposition_id)
