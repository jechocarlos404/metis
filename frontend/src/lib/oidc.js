// Server-side OIDC helpers for the BFF login flow. Browser-facing URLs
// (authorize, logout) use the public issuer; back-channel calls (token) use the
// internal URL so they resolve over the compose network. Keycloak's pinned
// KC_HOSTNAME keeps the token `iss` identical across both.

const ISSUER = () =>
  (process.env.KEYCLOAK_ISSUER || "http://localhost:8080/realms/metis").replace(/\/$/, "");
const INTERNAL = () =>
  (process.env.KEYCLOAK_INTERNAL_URL || "http://localhost:8080").replace(/\/$/, "");
const REALM = () => process.env.KEYCLOAK_REALM || "metis";
const APP_URL = () =>
  (process.env.PUBLIC_APP_URL || "http://localhost:4321").replace(/\/$/, "");

export const clientId = () => process.env.METIS_WEB_CLIENT_ID || "metis-web";
const clientSecret = () => process.env.METIS_WEB_CLIENT_SECRET || "dev-web-secret";

export const redirectUri = () => `${APP_URL()}/auth/callback`;
export const appUrl = APP_URL;
export const authorizeUrl = () => `${ISSUER()}/protocol/openid-connect/auth`;
export const endSessionUrl = () => `${ISSUER()}/protocol/openid-connect/logout`;
const tokenUrl = () =>
  `${INTERNAL()}/realms/${REALM()}/protocol/openid-connect/token`;

// --- PKCE (S256) via Web Crypto -------------------------------------------

function base64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomState() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function pkceChallenge() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// --- Token endpoint calls (back-channel) ----------------------------------

async function postToken(params) {
  params.set("client_id", clientId());
  params.set("client_secret", clientSecret());
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) {
    throw new Error(`Keycloak token endpoint ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export function exchangeCode(code, codeVerifier) {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: codeVerifier,
    }),
  );
}

export function refreshTokens(refreshToken) {
  return postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}
