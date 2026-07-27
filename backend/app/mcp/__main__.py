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

    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


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
        from starlette.routing import Mount, Route

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
            ]
        )
        uvicorn.run(app, host=args.host, port=args.port)
    else:
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(_stdio())
    asyncio.run(client.aclose())


if __name__ == "__main__":
    main()
