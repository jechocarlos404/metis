"""Entry point. stdio for local agent use, HTTP/SSE for the hosted case.

    python -m app.mcp                 # stdio, for Claude Code and similar
    python -m app.mcp --sse --port 8001
"""

import argparse
import asyncio
import contextlib

from app.mcp.server import client, server


async def _stdio() -> None:
    from mcp.server.stdio import stdio_server

    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        # Close the HTTP client on the loop that opened it; closing it later
        # from a fresh asyncio.run() prints "Event loop is closed" on exit.
        await client.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.mcp", description=__doc__)
    parser.add_argument("--sse", action="store_true", help="Serve over HTTP/SSE")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()

    if args.sse:
        import uvicorn
        from mcp.server.sse import SseServerTransport
        from starlette.applications import Starlette
        from starlette.middleware import Middleware
        from starlette.routing import Mount, Route

        from app.config import get_settings
        from app.mcp.auth import BearerGate

        # stdio inherits the identity of whoever launched it. A listening
        # socket does not — and this process holds a service token, so an
        # unauthenticated listener would lend that token to anyone who can
        # reach the port. Refuse to start rather than serve it open.
        token = get_settings().mcp_sse_token
        if not token:
            raise SystemExit(
                "MCP_SSE_TOKEN is required for --sse. Without it this port "
                "hands the server's API token to any caller that reaches it. "
                "Use stdio for local agents, which needs no token."
            )

        transport = SseServerTransport("/messages/")

        async def handle_sse(request):
            async with transport.connect_sse(
                request.scope, request.receive, request._send
            ) as (read, write):
                await server.run(read, write, server.create_initialization_options())

        app = Starlette(
            routes=[
                Route("/sse", endpoint=handle_sse),
                Mount("/messages/", app=transport.handle_post_message),
            ],
            middleware=[Middleware(BearerGate, token=token)],
        )
        uvicorn.run(app, host=args.host, port=args.port)
    else:
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(_stdio())


if __name__ == "__main__":
    main()
