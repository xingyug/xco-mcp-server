import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionKey,
  decodeJwtPayload,
  getTokenExpiresAt,
  isExpired,
  maskToken,
} from "../src/lib/auth.js";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("decodeJwtPayload parses JWT payload and expiry", () => {
  const token = makeJwt({ sub: "admin", exp: 4102444800 });
  assert.deepEqual(decodeJwtPayload(token), {
    sub: "admin",
    exp: 4102444800,
  });
  assert.equal(getTokenExpiresAt(token), "2100-01-01T00:00:00.000Z");
});

test("maskToken and buildSessionKey produce stable summaries", () => {
  assert.equal(maskToken("abcdefghijklmnopqrstuvwxyz"), "abcdefgh...stuvwxyz");
  assert.equal(maskToken("abcdefghij"), "abcd...ghij");
  assert.equal(maskToken("abcdefgh"), "***");
  assert.equal(maskToken("short"), "***");
  assert.equal(maskToken(null), null);
  assert.equal(
    buildSessionKey({
      version: "3.7.0",
      baseUrl: "https://xco.example",
      username: "admin",
    }),
    JSON.stringify({
      version: "3.7.0",
      baseUrl: "https://xco.example",
      username: "admin",
    }),
  );
});

test("isExpired respects expiry timestamps", () => {
  assert.equal(isExpired(new Date(Date.now() + 60_000).toISOString()), false);
  assert.equal(isExpired(new Date(Date.now() - 60_000).toISOString()), true);
});
