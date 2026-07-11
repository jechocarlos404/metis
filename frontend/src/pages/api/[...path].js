// Same-origin proxy to the FastAPI backend. Runtime-configured via
// API_INTERNAL_URL (Astro's PUBLIC_* env would be inlined at build time).
// Streams bodies through untouched so chat SSE renders incrementally.
export const prerender = false;

const backend = () =>
  (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

export async function ALL({ params, request }) {
  const url = new URL(request.url);
  const target = `${backend()}/api/${params.path}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return new Response(
      JSON.stringify({ detail: "Backend unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
