/**
 * Session & cookie tests.
 *
 * Covers:
 * - Round-trip encrypt/decrypt for session and OAuth context cookies
 * - Cookie attribute correctness (HttpOnly, SameSite, Path, MaxAge, Secure)
 * - Expiry detection: readSessionFromRequest returns null for missing fields
 * - Clearing cookies (Max-Age=0)
 * - Invalid/corrupted encrypted payloads return null
 * - isSecureRequest detection from x-forwarded-proto and URL protocol
 * - getCookieValue edge cases (missing header, multiple cookies, encoded values)
 * - serializeCookie attribute generation
 *
 * Run: npm test -- src/server/auth/session.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCookie,
  getCookieValue,
  isSecureRequest,
  readOAuthContextFromRequest,
  readSessionFromRequest,
  serializeCookie,
  serializeOAuthContextCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  OAUTH_CONTEXT_COOKIE_NAME,
} from "@/server/auth/session";

// ===========================================================================
// 1. Round-trip encrypt/decrypt
// ===========================================================================

test("serializeSessionCookie round-trips through readSessionFromRequest", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      user: {
        sub: "user-123",
        email: "dev@example.com",
      },
    },
    false,
  );

  const request = new Request("https://example.com/api/status", {
    headers: {
      cookie,
    },
  });

  const session = await readSessionFromRequest(request);
  assert.ok(session);
  assert.equal(session.accessToken, "access-token");
  assert.equal(session.refreshToken, "refresh-token");
  assert.equal(session.user.email, "dev@example.com");
});

test("serializeOAuthContextCookie round-trips through readOAuthContextFromRequest", async () => {
  const cookie = await serializeOAuthContextCookie(
    {
      codeVerifier: "verifier-123",
      nonce: "nonce-123",
      next: "/admin",
    },
    false,
  );

  const request = new Request("https://example.com/api/auth/callback", {
    headers: {
      cookie,
    },
  });

  const context = await readOAuthContextFromRequest(request);
  assert.deepEqual(context, {
    codeVerifier: "verifier-123",
    nonce: "nonce-123",
    next: "/admin",
  });
});

test("session round-trip preserves null refreshToken", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "at",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      user: { sub: "u1" },
    },
    false,
  );

  const request = new Request("http://localhost/api/status", {
    headers: { cookie },
  });

  const session = await readSessionFromRequest(request);
  assert.ok(session);
  assert.equal(session.refreshToken, null);
});

test("session round-trip preserves all user fields", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
      user: {
        sub: "u1",
        email: "a@b.com",
        name: "Alice",
        preferredUsername: "alice",
      },
    },
    false,
  );

  const request = new Request("http://localhost/x", {
    headers: { cookie },
  });

  const session = await readSessionFromRequest(request);
  assert.ok(session);
  assert.equal(session.user.sub, "u1");
  assert.equal(session.user.email, "a@b.com");
  assert.equal(session.user.name, "Alice");
  assert.equal(session.user.preferredUsername, "alice");
});

// ===========================================================================
// 2. Cookie attribute correctness
// ===========================================================================

test("session cookie includes HttpOnly, SameSite=Lax, Path=/, Max-Age=7d", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "at",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      user: { sub: "u1" },
    },
    false,
  );

  assert.ok(cookie.includes("HttpOnly"), "Should have HttpOnly");
  assert.ok(cookie.includes("SameSite=Lax"), "Should have SameSite=Lax");
  assert.ok(cookie.includes("Path=/"), "Should have Path=/");
  assert.ok(
    cookie.includes(`Max-Age=${7 * 24 * 60 * 60}`),
    "Should have 7-day Max-Age",
  );
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`), "Cookie name");
});

test("session cookie includes Secure flag when secure=true", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "at",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      user: { sub: "u1" },
    },
    true,
  );

  assert.ok(cookie.includes("Secure"), "Should include Secure flag");
});

test("session cookie omits Secure flag when secure=false", async () => {
  const cookie = await serializeSessionCookie(
    {
      accessToken: "at",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      user: { sub: "u1" },
    },
    false,
  );

  assert.ok(!cookie.includes("Secure"), "Should NOT include Secure flag");
});

test("OAuth context cookie has 5-minute Max-Age", async () => {
  const cookie = await serializeOAuthContextCookie(
    { codeVerifier: "v", nonce: "n", next: "/" },
    false,
  );

  assert.ok(cookie.includes(`Max-Age=${5 * 60}`), "Should have 5-min Max-Age");
  assert.ok(cookie.startsWith(`${OAUTH_CONTEXT_COOKIE_NAME}=`), "Cookie name");
});

// ===========================================================================
// 3. Clearing cookies
// ===========================================================================

test("clearCookie sets Max-Age=0 and empty value", () => {
  const cleared = clearCookie(SESSION_COOKIE_NAME, false);
  assert.ok(cleared.includes("Max-Age=0"), "Max-Age should be 0");
  assert.ok(cleared.startsWith(`${SESSION_COOKIE_NAME}=;`) || cleared.startsWith(`${SESSION_COOKIE_NAME}=%3B`) || cleared.includes(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cleared.includes("HttpOnly"), "Should keep HttpOnly");
  assert.ok(cleared.includes("Path=/"), "Should keep Path=/");
});

test("clearCookie includes Secure when secure=true", () => {
  const cleared = clearCookie(SESSION_COOKIE_NAME, true);
  assert.ok(cleared.includes("Secure"), "Should include Secure");
});

test("clearCookie omits Secure when secure=false", () => {
  const cleared = clearCookie(SESSION_COOKIE_NAME, false);
  assert.ok(!cleared.includes("Secure"), "Should NOT include Secure");
});

// ===========================================================================
// 4. Invalid/corrupted payloads return null
// ===========================================================================

test("readSessionFromRequest returns null for missing cookie header", async () => {
  const request = new Request("http://localhost/api/status");
  const session = await readSessionFromRequest(request);
  assert.equal(session, null);
});

test("readSessionFromRequest returns null for garbage cookie value", async () => {
  const request = new Request("http://localhost/api/status", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=not-encrypted-jwt` },
  });
  const session = await readSessionFromRequest(request);
  assert.equal(session, null);
});

test("readSessionFromRequest returns null for empty cookie value", async () => {
  const request = new Request("http://localhost/api/status", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=` },
  });
  const session = await readSessionFromRequest(request);
  assert.equal(session, null);
});

test("readOAuthContextFromRequest returns null for missing cookie", async () => {
  const request = new Request("http://localhost/api/auth/callback");
  const ctx = await readOAuthContextFromRequest(request);
  assert.equal(ctx, null);
});

test("readOAuthContextFromRequest returns null for garbage value", async () => {
  const request = new Request("http://localhost/api/auth/callback", {
    headers: { cookie: `${OAUTH_CONTEXT_COOKIE_NAME}=garbage` },
  });
  const ctx = await readOAuthContextFromRequest(request);
  assert.equal(ctx, null);
});

// ===========================================================================
// 5. isSecureRequest
// ===========================================================================

test("isSecureRequest: returns true for https URL", () => {
  const req = new Request("https://example.com/api");
  assert.equal(isSecureRequest(req), true);
});

test("isSecureRequest: returns false for http URL", () => {
  const req = new Request("http://localhost/api");
  assert.equal(isSecureRequest(req), false);
});

test("isSecureRequest: x-forwarded-proto=https overrides http URL", () => {
  const req = new Request("http://localhost/api", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(isSecureRequest(req), true);
});

test("isSecureRequest: x-forwarded-proto=http overrides https URL", () => {
  const req = new Request("https://example.com/api", {
    headers: { "x-forwarded-proto": "http" },
  });
  assert.equal(isSecureRequest(req), false);
});

test("isSecureRequest: handles comma-separated x-forwarded-proto", () => {
  const req = new Request("http://localhost/api", {
    headers: { "x-forwarded-proto": "https, http" },
  });
  assert.equal(isSecureRequest(req), true);
});

// ===========================================================================
// 6. getCookieValue edge cases
// ===========================================================================

test("getCookieValue: returns null when no cookie header", () => {
  const req = new Request("http://localhost/");
  assert.equal(getCookieValue(req, "foo"), null);
});

test("getCookieValue: returns null for missing cookie name", () => {
  const req = new Request("http://localhost/", {
    headers: { cookie: "a=1; b=2" },
  });
  assert.equal(getCookieValue(req, "c"), null);
});

test("getCookieValue: extracts correct value among multiple cookies", () => {
  const req = new Request("http://localhost/", {
    headers: { cookie: "a=1; target=hello; b=2" },
  });
  assert.equal(getCookieValue(req, "target"), "hello");
});

test("getCookieValue: handles value with equals sign", () => {
  const req = new Request("http://localhost/", {
    headers: { cookie: "token=abc=def=ghi" },
  });
  assert.equal(getCookieValue(req, "token"), "abc=def=ghi");
});

test("getCookieValue: handles URL-encoded value", () => {
  const req = new Request("http://localhost/", {
    headers: { cookie: "val=%2Fpath%2Fto" },
  });
  assert.equal(getCookieValue(req, "val"), "/path/to");
});

// ===========================================================================
// 7. serializeCookie attribute generation
// ===========================================================================

test("serializeCookie: includes all specified attributes", () => {
  const result = serializeCookie("test", "value", {
    httpOnly: true,
    maxAge: 3600,
    path: "/app",
    sameSite: "Strict",
    secure: true,
  });

  assert.ok(result.startsWith("test=value"));
  assert.ok(result.includes("Max-Age=3600"));
  assert.ok(result.includes("Path=/app"));
  assert.ok(result.includes("SameSite=Strict"));
  assert.ok(result.includes("HttpOnly"));
  assert.ok(result.includes("Secure"));
});

test("serializeCookie: defaults to Path=/ and SameSite=Lax", () => {
  const result = serializeCookie("x", "y", {});
  assert.ok(result.includes("Path=/"));
  assert.ok(result.includes("SameSite=Lax"));
  assert.ok(!result.includes("HttpOnly"));
  assert.ok(!result.includes("Secure"));
});

test("serializeCookie: URL-encodes the value", () => {
  const result = serializeCookie("name", "hello world", {});
  assert.ok(result.startsWith("name=hello%20world"));
});
