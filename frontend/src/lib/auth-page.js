// A small page instead of bare text for the sign-in routes: says what happened
// and offers the way back in.
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function signInPage(status, message, { title = "Sign-in failed", heading = "Sign-in didn't finish", retry = true } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · metis</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#f8f7f4;color:#2b2a27}
main{max-width:28rem;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#5f5d57}a{display:inline-block;padding:8px 14px;border-radius:6px;background:#2f5f8a;color:#fff;text-decoration:none}</style></head>
<body><main><h1>${esc(heading)}</h1><p>${esc(message)}</p>${retry ? '<a href="/auth/login">Sign in again</a>' : ""}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
