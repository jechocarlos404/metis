"""A per-caller rate limit for the one endpoint that returns people.

`tech_encounters` answers "who could I ask". That is a useful question and a
poor directory: nobody should be able to enumerate the org through the tech
catalog one slug at a time. So the endpoint is throttled per caller and every
call is logged with the caller's identity — the log is the part that matters,
because it makes an unusual access pattern visible after the fact.

In-process, like the feature graph. That is honest here for the same reason:
the app already runs one worker on purpose (`--workers 1` is load-bearing in
the Dockerfile). If it ever runs several, this becomes per-worker and the
limit needs to move to Postgres or Redis — the log does not.
"""

import logging
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request, status

from app.auth.deps import current_user
from app.auth.jwt import Principal

log = logging.getLogger("metis.access")

#: Generous enough that reading a stack's worth of slugs never trips it, tight
#: enough that walking the catalog does.
LIMIT = 30
WINDOW_SECONDS = 60

_calls: dict[str, deque[float]] = defaultdict(deque)


def _allow(caller: str, now: float) -> tuple[bool, int]:
    """Sliding window. Returns (allowed, seconds until a slot frees)."""
    seen = _calls[caller]
    while seen and seen[0] <= now - WINDOW_SECONDS:
        seen.popleft()
    if len(seen) >= LIMIT:
        return False, max(1, int(WINDOW_SECONDS - (now - seen[0])))
    seen.append(now)
    return True, 0


def reset() -> None:
    """Test hook — the window is process state, so it outlives a test."""
    _calls.clear()


async def throttle_people(
    request: Request, principal: Principal = Depends(current_user)
) -> Principal:
    allowed, retry_after = _allow(principal.sub, time.monotonic())
    log.info(
        "encounters read caller=%s surface=%s path=%s allowed=%s",
        principal.username or principal.sub,
        principal.surface,
        request.url.path,
        allowed,
    )
    if not allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Rate limit: {LIMIT} people lookups per {WINDOW_SECONDS}s",
            headers={"Retry-After": str(retry_after)},
        )
    return principal
