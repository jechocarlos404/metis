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

// A small page instead of bare text: says what happened and offers the way back in.
function failure(status, message) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in failed · metis</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#f8f7f4;color:#2b2a27}
main{max-width:28rem;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#5f5d57}a{display:inline-block;padding:8px 14px;border-radius:6px;background:#2f5f8a;color:#fff;text-decoration:none}</style></head>
<body><main><h1>Sign-in didn't finish</h1><p>${esc(message)}</p><a href="/auth/login">Sign in again</a></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET({ url, cookies, redirect }) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = await readOidcState(cookies);
  clearOidcState(cookies);

  if (!code || !saved || saved.state !== state) {
    return failure(400, "The sign-in link expired or was opened in another tab.");
  }

  try {
    const tokens = await exchangeCode(code, saved.verifier);
    await writeSession(cookies, sessionFromTokens(tokens));
  } catch (err) {
    return failure(502, `The sign-in server didn't accept the request (${err.message}).`);
  }

  const returnTo = typeof saved.returnTo === "string" && saved.returnTo.startsWith("/")
    ? saved.returnTo
    : "/";
  return redirect(returnTo, 302);
}
