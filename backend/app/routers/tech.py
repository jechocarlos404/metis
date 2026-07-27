import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.technology import (
    AdoptionRead,
    AdoptionWrite,
    EncounterCreate,
    EncounterRead,
    Exposure,
    Offer,
    SatisfactionCreate,
    SatisfactionRead,
    SatisfactionUpdate,
    TechEdgeCreate,
    TechEdgeRead,
    TechnologyCreate,
    TechnologyDetail,
    TechnologyPage,
    TechnologyRead,
    TechnologyRow,
    TechnologyUpdate,
    VendorCreate,
    VendorRead,
    VendorUpdate,
    VersionCreate,
    VersionRead,
    VersionUpdate,
)
from app.models import Technology
from app.services import technologies as tech_service
from app.services.slugs import by_slug

router = APIRouter(prefix="/api/tech", tags=["tech"])


async def _id(session: AsyncSession, slug: str) -> uuid.UUID:
    return (await by_slug(session, Technology, slug, "Technology")).id


def _row(entry: dict) -> TechnologyRow:
    return TechnologyRow(
        **TechnologyRead.model_validate(entry["technology"]).model_dump(),
        adoption=entry["adoption"],
        satisfies=entry["satisfies"],
        used_by=entry["used_by"],
    )


@router.get("", response_model=TechnologyPage)
async def catalog(
    q: str | None = None,
    kind: str | None = None,
    layer: str | None = None,
    adoption: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db),
):
    page = await tech_service.catalog(session, q, kind, layer, adoption, limit, offset)
    return TechnologyPage(
        rows=[_row(entry) for entry in page["rows"]],
        total=page["total"],
        facet_counts=page["facet_counts"],
    )


@router.post("", response_model=TechnologyRead, status_code=201)
async def create_technology(data: TechnologyCreate, session: AsyncSession = Depends(get_db)):
    return await tech_service.create_technology(session, data)


# NB: static routes must be registered before /{slug}. A technology is
# addressed by its slug everywhere a human or an agent quotes it; the UUID
# stays the key, but it is not the name.
@router.get("/vendors", response_model=list[VendorRead])
async def list_vendors(session: AsyncSession = Depends(get_db)):
    return await tech_service.list_vendors(session)


@router.post("/vendors", response_model=VendorRead, status_code=201)
async def create_vendor(data: VendorCreate, session: AsyncSession = Depends(get_db)):
    return await tech_service.create_vendor(session, data)


@router.patch("/vendors/{vendor_id}", response_model=VendorRead)
async def update_vendor(
    vendor_id: uuid.UUID, data: VendorUpdate, session: AsyncSession = Depends(get_db)
):
    return await tech_service.update_vendor(session, vendor_id, data)


@router.delete("/vendors/{vendor_id}", status_code=204)
async def delete_vendor(vendor_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await tech_service.delete_vendor(session, vendor_id)


@router.get("/exposure", response_model=list[Exposure])
async def exposure(session: AsyncSession = Depends(get_db)):
    """What are we exposed to: EOL inside 180 days, a stance already given up
    on, or a bus factor of one. Computed per request, never stored."""
    return await tech_service.exposure(session)


@router.get("/offers", response_model=list[Offer])
async def offers(
    capability_id: uuid.UUID,
    product_id: uuid.UUID | None = None,
    stack_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_db),
):
    """Which technologies can satisfy this capability, pruned and ranked."""
    return await tech_service.offers(session, capability_id, product_id, stack_id)


@router.get("/edges", response_model=list[TechEdgeRead])
async def list_edges(session: AsyncSession = Depends(get_db)):
    return await tech_service.list_edges(session)


@router.post("/edges", response_model=TechEdgeRead, status_code=201)
async def create_edge(data: TechEdgeCreate, session: AsyncSession = Depends(get_db)):
    return await tech_service.create_edge(session, data)


@router.delete("/edges/{edge_id}", status_code=204)
async def delete_edge(edge_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await tech_service.delete_edge(session, edge_id)


@router.get("/satisfactions", response_model=list[SatisfactionRead])
async def list_satisfactions(
    tech_id: uuid.UUID | None = None,
    capability_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_db),
):
    return await tech_service.list_satisfactions(session, tech_id, capability_id)


@router.post("/satisfactions", response_model=SatisfactionRead, status_code=201)
async def create_satisfaction(
    data: SatisfactionCreate, session: AsyncSession = Depends(get_db)
):
    return await tech_service.create_satisfaction(session, data)


@router.patch("/satisfactions/{satisfaction_id}", response_model=SatisfactionRead)
async def update_satisfaction(
    satisfaction_id: uuid.UUID,
    data: SatisfactionUpdate,
    session: AsyncSession = Depends(get_db),
):
    return await tech_service.update_satisfaction(session, satisfaction_id, data)


@router.delete("/satisfactions/{satisfaction_id}", status_code=204)
async def delete_satisfaction(
    satisfaction_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await tech_service.delete_satisfaction(session, satisfaction_id)


@router.post("/encounters", response_model=EncounterRead, status_code=201)
async def create_encounter(data: EncounterCreate, session: AsyncSession = Depends(get_db)):
    return await tech_service.create_encounter(session, data)


@router.delete("/encounters/{encounter_id}", status_code=204)
async def delete_encounter(
    encounter_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await tech_service.delete_encounter(session, encounter_id)


@router.patch("/versions/{version_id}", response_model=VersionRead)
async def update_version(
    version_id: uuid.UUID, data: VersionUpdate, session: AsyncSession = Depends(get_db)
):
    return await tech_service.update_version(session, version_id, data)


@router.delete("/versions/{version_id}", status_code=204)
async def delete_version(version_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await tech_service.delete_version(session, version_id)


@router.get("/{slug}", response_model=TechnologyDetail)
async def get_technology(slug: str, session: AsyncSession = Depends(get_db)):
    entry = await tech_service.detail(session, await _id(session, slug))
    return TechnologyDetail(
        **_row(entry).model_dump(),
        vendor=entry["vendor"],
        versions=entry["versions"],
        satisfactions=entry["satisfactions"],
        outgoing=entry["outgoing"],
        incoming=entry["incoming"],
        encounters=entry["encounters"],
    )


@router.patch("/{slug}", response_model=TechnologyRead)
async def update_technology(
    slug: str, data: TechnologyUpdate, session: AsyncSession = Depends(get_db)
):
    return await tech_service.update_technology(session, await _id(session, slug), data)


@router.delete("/{slug}", status_code=204)
async def delete_technology(slug: str, session: AsyncSession = Depends(get_db)):
    await tech_service.delete_technology(session, await _id(session, slug))


@router.get("/{slug}/versions", response_model=list[VersionRead])
async def versions(slug: str, session: AsyncSession = Depends(get_db)):
    return await tech_service.list_versions(session, await _id(session, slug))


@router.post("/{slug}/versions", response_model=VersionRead, status_code=201)
async def create_version(
    slug: str, data: VersionCreate, session: AsyncSession = Depends(get_db)
):
    return await tech_service.create_version(session, await _id(session, slug), data)


@router.get("/{slug}/adoption", response_model=AdoptionRead | None)
async def get_adoption(slug: str, session: AsyncSession = Depends(get_db)):
    """None means no stance has been taken — which is itself an answer."""
    return await tech_service.get_adoption(session, await _id(session, slug))


@router.put("/{slug}/adoption", response_model=AdoptionRead)
async def set_adoption(
    slug: str, data: AdoptionWrite, session: AsyncSession = Depends(get_db)
):
    return await tech_service.set_adoption(session, await _id(session, slug), data)


@router.delete("/{slug}/adoption", status_code=204)
async def clear_adoption(slug: str, session: AsyncSession = Depends(get_db)):
    await tech_service.clear_adoption(session, await _id(session, slug))
