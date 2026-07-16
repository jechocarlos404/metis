export class ApiError extends Error {
  constructor(detail, status) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.detail = detail;
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    // Declared on every mutating request, even body-less DELETE/POST: Astro's
    // CSRF guard (security.checkOrigin) 403s "simple"-content-type requests
    // in production builds, and a missing content-type counts as simple.
    headers: method !== "GET" ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Session expired or missing → bounce to login (BFF middleware returns 401
  // JSON for /api/* rather than an HTML redirect).
  if (res.status === 401 && typeof window !== "undefined") {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/auth/login?returnTo=${returnTo}`;
    throw new ApiError("Not authenticated", 401);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}
