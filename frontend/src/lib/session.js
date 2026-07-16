// BFF session: tokens live in an httpOnly, JWE-encrypted cookie the browser JS
// never sees. The sealed payload (access + refresh + id tokens) exceeds the 4KB
// single-cookie limit, so it is split across numbered chunk cookies.

import { createHash } from "node:crypto";
import * as jose from "jose";

const SESSION = "mx_session";
const OIDC = "mx_oidc";
const MANAGED_ROLES = ["admin", "editor", "viewer"];
const CHUNK = 3500; // per-cookie value budget, safely under browsers' ~4KB
const MAX_CHUNKS = 8;

const key = () =>
  createHash("sha256")
    .update(process.env.SESSION_SECRET || "dev-session-secret-change-me-32bytes!")
    .digest();

// Secure flag follows the app's scheme: off for http://localhost dev, on for https.
const SECURE = (process.env.PUBLIC_APP_URL || "http://localhost:4321").startsWith("https");
const baseOpts = { httpOnly: true, sameSite: "lax", path: "/", secure: SECURE };

async function seal(payload, ttl) {
  return await new jose.EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .encrypt(key());
}

async function unseal(jwe) {
  try {
    const { payload } = await jose.jwtDecrypt(jwe, key());
    return payload;
  } catch {
    return null; // tampered, expired, or key rotated
  }
}

// --- chunked session cookie ------------------------------------------------

function clearChunks(cookies) {
  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (cookies.has(`${SESSION}.${i}`)) cookies.delete(`${SESSION}.${i}`, { path: "/" });
  }
}

export async function writeSession(cookies, session) {
  const jwe = await seal(session, "12h");
  clearChunks(cookies);
  for (let i = 0; i * CHUNK < jwe.length; i++) {
    cookies.set(`${SESSION}.${i}`, jwe.slice(i * CHUNK, (i + 1) * CHUNK), {
      ...baseOpts,
      maxAge: 60 * 60 * 12,
    });
  }
}

export async function readSession(cookies) {
  let jwe = "";
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = cookies.get(`${SESSION}.${i}`);
    if (!part?.value) break;
    jwe += part.value;
  }
  if (!jwe) return null;
  return await unseal(jwe);
}

export function clearSession(cookies) {
  clearChunks(cookies);
}

// --- session shape from Keycloak tokens ------------------------------------

export function sessionFromTokens(tokens) {
  const claims = jose.decodeJwt(tokens.access_token);
  const roles = (claims.realm_access?.roles ?? []).filter((r) => MANAGED_ROLES.includes(r));
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    expires_at: Date.now() + (tokens.expires_in ?? 300) * 1000,
    user: {
      sub: claims.sub,
      username: claims.preferred_username ?? "",
      name: claims.name ?? claims.preferred_username ?? "",
      email: claims.email ?? null,
      roles,
      role: MANAGED_ROLES.find((r) => roles.includes(r)) ?? null,
    },
  };
}

// --- short-lived OIDC round-trip state (PKCE verifier + CSRF state) ---------

export async function writeOidcState(cookies, data) {
  cookies.set(OIDC, await seal(data, "10m"), { ...baseOpts, maxAge: 600 });
}

export async function readOidcState(cookies) {
  const raw = cookies.get(OIDC)?.value;
  return raw ? await unseal(raw) : null;
}

export function clearOidcState(cookies) {
  if (cookies.has(OIDC)) cookies.delete(OIDC, { path: "/" });
}
