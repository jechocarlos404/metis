from fastapi import APIRouter, Request
from sqlalchemy import text

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict:
    checks = {"api": "ok", "db": "unknown", "graph": "unknown"}
    sessionmaker = getattr(request.app.state, "sessionmaker", None)
    if sessionmaker is not None:
        try:
            async with sessionmaker() as session:
                await session.execute(text("SELECT 1"))
            checks["db"] = "ok"
        except Exception:
            checks["db"] = "down"
    graph = getattr(request.app.state, "graph", None)
    if graph is not None:
        checks["graph"] = f"ok ({graph.node_count()} nodes)"
    status = "ok" if checks["db"] != "down" else "degraded"
    return {"status": status, "checks": checks}
