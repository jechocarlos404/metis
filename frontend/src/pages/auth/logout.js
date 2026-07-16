// Clear the local session and end the Keycloak SSO session (RP-initiated logout).
export const prerender = false;

import { appUrl, clientId, endSessionUrl } from "../../lib/oidc.js";
import { clearSession, readSession } from "../../lib/session.js";

export async function GET({ cookies, redirect }) {
  const session = await readSession(cookies);
  clearSession(cookies);

  const logout = new URL(endSessionUrl());
  logout.searchParams.set("post_logout_redirect_uri", `${appUrl()}/`);
  if (session?.id_token) logout.searchParams.set("id_token_hint", session.id_token);
  else logout.searchParams.set("client_id", clientId());

  return redirect(logout.toString(), 302);
}
