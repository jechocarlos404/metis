// Start the OIDC Authorization Code + PKCE flow: stash the verifier/state/returnTo
// in a short-lived cookie, then redirect the browser to Keycloak.
export const prerender = false;

import { authorizeUrl, clientId, pkceChallenge, randomState, redirectUri } from "../../lib/oidc.js";
import { writeOidcState } from "../../lib/session.js";

export async function GET({ url, cookies, redirect }) {
  const returnTo = url.searchParams.get("returnTo") || "/";
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
