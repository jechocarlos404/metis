"""Read-only MCP server over the Metis ontology.

Note the import direction: this package imports the installed `mcp` SDK by its
absolute name, which is a different module from `app.mcp`. Nothing here is
imported by the FastAPI app — the server is a separate process that talks to
the API over HTTP, which is what makes its token, and therefore its read-only
boundary, real.
"""
