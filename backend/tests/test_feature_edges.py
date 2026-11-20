"""A refused circular dependency names the chain it would close, so the
person (or agent) knows which link to remove."""

import pytest
from fastapi import HTTPException

from app.schemas.feature import EdgeCreate, FeatureCreate
from app.services import features as feature_service
from app.services.graph_service import FeatureGraph


async def test_a_refused_cycle_names_the_existing_chain(db):
    async with db() as session:
        graph = FeatureGraph(sessionmaker=None)

        async def make(name):
            return await feature_service.create_feature(
                session, FeatureCreate(name=name, unknown_capabilities=True), graph
            )

        async def refused(src, dst, kind="DEPENDS_ON"):
            with pytest.raises(HTTPException) as err:
                await feature_service.create_edge(
                    session, EdgeCreate(src_id=src.id, dst_id=dst.id, kind=kind), graph
                )
            assert err.value.status_code == 422
            return err.value.detail

        write, sync, share = await make("Write a note"), await make("Sync notes"), await make("Share notes")
        await feature_service.create_edge(
            session, EdgeCreate(src_id=share.id, dst_id=sync.id, kind="DEPENDS_ON"), graph
        )
        # BLOCKS flips direction: write blocks sync means sync needs write.
        await feature_service.create_edge(
            session, EdgeCreate(src_id=write.id, dst_id=sync.id, kind="BLOCKS"), graph
        )

        assert await refused(write, share) == (
            "That would make a circular dependency: “Share notes” already needs "
            "“Write a note” through “Sync notes”. Remove a link in that chain first."
        )
        # share blocks write means write needs share: the same loop, named the same way.
        assert await refused(share, write, "BLOCKS") == await refused(write, share)
        assert await refused(sync, share) == (
            "That would make a circular dependency: “Share notes” already needs "
            "“Sync notes”. Remove a link in that chain first."
        )
