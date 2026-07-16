// BFF guard. Every request except the auth routes, the public health check, and
// static assets requires a session. Pages without one redirect to login; /api/*
// without one gets a 401 (so island fetches see an error, not an HTML redirect).
// Near-expiry access tokens are refreshed transparently here.

import { defineMiddleware } from "astro:middleware";
import { refreshTokens } from "./lib/oidc.js";
import {
  clearSession,
  readSession,
  sessionFromTokens,
  writeSession,
} from "./lib/session.js";

const REFRESH_SKEW_MS = 30_000;

function isPublic(pathname) {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/_") || // /_astro, /_image, /_actions
    pathname === "/favicon.ico"
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, locals } = context;
  const { pathname } = url;

  if (isPublic(pathname)) return next();

  let session = await readSession(cookies);

  if (session && session.expires_at - Date.now() < REFRESH_SKEW_MS) {
    try {
      session = sessionFromTokens(await refreshTokens(session.refresh_token));
      await writeSession(cookies, session);
    } catch {
      clearSession(cookies);
      session = null;
    }
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ detail: "Not authenticated" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const returnTo = pathname + url.search;
    return context.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  locals.user = session.user;
  locals.accessToken = session.access_token;
  return next();
});
