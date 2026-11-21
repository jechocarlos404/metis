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
import { signInPage } from "../../lib/auth-page.js";

// Same rule as login.js: a path on this site, never `//host`, `/\host` or a
// control character a browser would strip into one.
const LOCAL_PATH = /^\/(?![/\\])[^\x00-\x1f\x7f]*$/;

export async function GET({ url, cookies, redirect }) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = await readOidcState(cookies);
  clearOidcState(cookies);

  if (!code || !saved || saved.state !== state) {
    return signInPage(400, "The sign-in link expired or was opened in another tab.");
  }

  try {
    const tokens = await exchangeCode(code, saved.verifier);
    await writeSession(cookies, sessionFromTokens(tokens));
  } catch (err) {
    return signInPage(502, `The sign-in server didn't accept the request (${err.message}).`);
  }

  const returnTo = typeof saved.returnTo === "string" && LOCAL_PATH.test(saved.returnTo)
    ? saved.returnTo
    : "/";
  return redirect(returnTo, 302);
}
