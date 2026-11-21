import { test } from "node:test";
import assert from "node:assert/strict";
import { readOidcState, sessionSecretProblem, writeOidcState } from "../src/lib/session.js";

const DEFAULT = "dev-session-secret-change-me-32bytes!";

// A cookie jar shaped like Astro's, enough for the OIDC state cookie.
function jar() {
  const values = new Map();
  return {
    set: (name, value) => values.set(name, { value }),
    get: (name) => values.get(name),
    has: (name) => values.has(name),
    delete: (name) => values.delete(name),
  };
}

async function withEnv(env, fn) {
  const saved = { AUTH_ENABLED: process.env.AUTH_ENABLED, SESSION_SECRET: process.env.SESSION_SECRET };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("auth on refuses a missing or default secret, and says why", () => {
  for (const env of [{}, { AUTH_ENABLED: "true" }, { AUTH_ENABLED: "" }]) {
    assert.match(sessionSecretProblem(env), /SESSION_SECRET is not set while AUTH_ENABLED is on/);
    assert.match(sessionSecretProblem({ ...env, SESSION_SECRET: DEFAULT }), /SESSION_SECRET is the public default/);
  }
  assert.equal(sessionSecretProblem({ AUTH_ENABLED: "true", SESSION_SECRET: "a-real-random-secret" }), null);
});

test("auth off accepts any secret, read the way the backend reads AUTH_ENABLED", () => {
  for (const off of ["false", "False", " FALSE ", "0", "no", "off"]) {
    assert.equal(sessionSecretProblem({ AUTH_ENABLED: off }), null);
    assert.equal(sessionSecretProblem({ AUTH_ENABLED: off, SESSION_SECRET: DEFAULT }), null);
  }
});

test("with auth on and the default secret, no sign-in starts and no cookie opens", async () => {
  await withEnv({ AUTH_ENABLED: "true", SESSION_SECRET: DEFAULT }, async () => {
    const cookies = jar();
    await assert.rejects(writeOidcState(cookies, { state: "s" }), /Sign-in refused/);
    // A cookie sealed with the default elsewhere doesn't open either.
    await withEnv({ AUTH_ENABLED: "false" }, () => writeOidcState(cookies, { state: "s" }));
    assert.equal(await readOidcState(cookies), null);
  });
});

test("with auth off the default secret still seals and opens", async () => {
  await withEnv({ AUTH_ENABLED: "false", SESSION_SECRET: DEFAULT }, async () => {
    const cookies = jar();
    await writeOidcState(cookies, { state: "s" });
    assert.equal((await readOidcState(cookies)).state, "s");
  });
});

test("with auth on and a real secret, sign-in works", async () => {
  await withEnv({ AUTH_ENABLED: "true", SESSION_SECRET: "a-real-random-secret" }, async () => {
    const cookies = jar();
    await writeOidcState(cookies, { state: "s" });
    assert.equal((await readOidcState(cookies)).state, "s");
  });
});
