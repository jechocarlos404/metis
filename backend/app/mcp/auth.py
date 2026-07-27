"""Who may talk to the MCP server.

Distinct from the token the server uses to talk to the API, and easy to
conflate. That one proves *the server* is read-scoped. This one proves the
caller is allowed to use the server at all.

Only the SSE transport needs it. stdio is a child process of whoever launched
it and inherits their identity; a listening socket inherits nothing, and this
process holds a service token — so without a gate the port lends that token to
anyone who can reach it. That is a confused deputy, and the fact that the token
is read-only bounds the damage without making it acceptable.
"""

import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class BearerGate(BaseHTTPMiddleware):
    def __init__(self, app, token: str):
        super().__init__(app)
        self._token = token

    async def dispatch(self, request, call_next):
        header = request.headers.get("authorization", "")
        scheme, _, presented = header.partition(" ")
        # Constant-time: the comparison is against a shared secret, and a
        # timing signal on a listening port is worth avoiding for free.
        if scheme.lower() != "bearer" or not hmac.compare_digest(presented, self._token):
            return JSONResponse(
                {"error": "unauthorized", "message": "MCP requires a bearer token."},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)
