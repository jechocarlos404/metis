// OIDC redirect target: verify state, exchange the code for tokens, open the
// session, and land the user where they started.
export const prerender = false;

import { exchangeCode } from "../../lib/oidc.js";
import {
  clearOidcState,
  readOidcState,
  sessionFromTokens,
  writeSession,
} from "../../lib/session.js";

export async function GET({ url, cookies, redirect }) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = await readOidcState(cookies);
  clearOidcState(cookies);

  if (!code || !saved || saved.state !== state) {
    return new Response("Invalid authentication state. Please try again.", { status: 400 });
  }

  try {
    const tokens = await exchangeCode(code, saved.verifier);
    await writeSession(cookies, sessionFromTokens(tokens));
  } catch (err) {
    return new Response(`Login failed: ${err.message}`, { status: 502 });
  }

  const returnTo = typeof saved.returnTo === "string" && saved.returnTo.startsWith("/")
    ? saved.returnTo
    : "/";
  return redirect(returnTo, 302);
}
