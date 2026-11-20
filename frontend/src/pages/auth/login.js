// Start the OIDC Authorization Code + PKCE flow: stash the verifier/state/returnTo
// in a short-lived cookie, then redirect the browser to Keycloak.
export const prerender = false;

import { authorizeUrl, clientId, pkceChallenge, randomState, redirectUri } from "../../lib/oidc.js";
import { writeOidcState } from "../../lib/session.js";

// A path on this site only. `//host` and `/\host` leave it, and browsers drop
// tabs and newlines before resolving, so `/<tab>/host` does too.
const LOCAL_PATH = /^\/(?![/\\])[^\x00-\x1f\x7f]*$/;

export async function GET({ url, cookies, redirect }) {
  const asked = url.searchParams.get("returnTo");
  const returnTo = asked && LOCAL_PATH.test(asked) ? asked : "/";
  const state = randomState();
  const { verifier, challenge } = await pkceChallenge();
  await writeOidcState(cookies, { state, verifier, returnTo });

  const authorize = new URL(authorizeUrl());
  authorize.search = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  return redirect(authorize.toString(), 302);
}
