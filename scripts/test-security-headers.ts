/**
 * Behavioral tests for the security header policy.
 *
 * Run with Node 22+:
 *   node --experimental-strip-types scripts/test-security-headers.ts
 *
 * Header sets are easy to break silently — a typo in a directive name is not a
 * syntax error, it is just a directive the browser ignores. These assertions
 * pin the exact policy so a regression fails the build instead of quietly
 * loosening the app.
 */

import {
  HSTS_MAX_AGE_SECONDS,
  securityHeaders,
} from "../src/lib/security/headers.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${name}`);
  if (detail !== undefined) {
    console.error(`        got: ${JSON.stringify(detail)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const prod = securityHeaders({ isProduction: true });
const dev = securityHeaders({ isProduction: false });

/** Parse a CSP string into directive -> values. */
function parseCsp(csp: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const [name, ...values] = trimmed.split(/\s+/);
    result[name] = values;
  }

  return result;
}

const prodCsp = parseCsp(prod["Content-Security-Policy"]);
const devCsp = parseCsp(dev["Content-Security-Policy"]);

// ---------------------------------------------------------------------------
section("Required headers are present");
// ---------------------------------------------------------------------------

for (const header of [
  "Content-Security-Policy",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
]) {
  check(`${header} is set in production`, typeof prod[header] === "string" && prod[header].length > 0);
  check(`${header} is set in development`, typeof dev[header] === "string" && dev[header].length > 0);
}

check("X-Frame-Options denies framing", prod["X-Frame-Options"] === "DENY", prod["X-Frame-Options"]);
check("nosniff is exact", prod["X-Content-Type-Options"] === "nosniff");
check(
  "referrer policy does not leak paths cross-site",
  prod["Referrer-Policy"] === "strict-origin-when-cross-origin",
  prod["Referrer-Policy"],
);

// ---------------------------------------------------------------------------
section("HSTS");
// ---------------------------------------------------------------------------

check("HSTS is sent in production", typeof prod["Strict-Transport-Security"] === "string");
check(
  "HSTS is NOT sent in development",
  dev["Strict-Transport-Security"] === undefined,
  dev["Strict-Transport-Security"],
);
check(
  "HSTS max-age is at least one year",
  prod["Strict-Transport-Security"].includes(`max-age=${HSTS_MAX_AGE_SECONDS}`) &&
    HSTS_MAX_AGE_SECONDS >= 31536000,
  prod["Strict-Transport-Security"],
);
check(
  "HSTS covers subdomains and is preload-eligible",
  prod["Strict-Transport-Security"].includes("includeSubDomains") &&
    prod["Strict-Transport-Security"].includes("preload"),
  prod["Strict-Transport-Security"],
);

// ---------------------------------------------------------------------------
section("CSP — lockdown directives");
// ---------------------------------------------------------------------------

check("default-src is self", prodCsp["default-src"]?.join(" ") === "'self'", prodCsp["default-src"]);
check("object-src is none", prodCsp["object-src"]?.join(" ") === "'none'", prodCsp["object-src"]);
check("frame-src is none", prodCsp["frame-src"]?.join(" ") === "'none'", prodCsp["frame-src"]);
check(
  "frame-ancestors is none",
  prodCsp["frame-ancestors"]?.join(" ") === "'none'",
  prodCsp["frame-ancestors"],
);
check("base-uri is constrained", prodCsp["base-uri"]?.join(" ") === "'self'", prodCsp["base-uri"]);
check(
  "form-action is self only — blocks credential exfiltration",
  prodCsp["form-action"]?.join(" ") === "'self'",
  prodCsp["form-action"],
);
check(
  "connect-src is self only — no third-party or model-provider egress",
  prodCsp["connect-src"]?.join(" ") === "'self'",
  prodCsp["connect-src"],
);

// ---------------------------------------------------------------------------
section("CSP — no wildcards anywhere");
// ---------------------------------------------------------------------------

{
  // A bare `*`, or an https: scheme source, would defeat most of the policy.
  const offenders = Object.entries(prodCsp).filter(([, values]) =>
    values.some((value) => value === "*" || value === "https:" || value === "http:"),
  );

  check("no directive allows a wildcard or bare scheme", offenders.length === 0, offenders);
}

{
  const external = Object.entries(prodCsp).filter(([, values]) =>
    values.some((value) => value.startsWith("http://") || value.startsWith("https://")),
  );

  check("no remote hosts are allowlisted", external.length === 0, external);
}

// ---------------------------------------------------------------------------
section("CSP — dev vs prod differences are intentional");
// ---------------------------------------------------------------------------

check(
  "unsafe-eval is allowed in development only (React Fast Refresh)",
  devCsp["script-src"].includes("'unsafe-eval'") &&
    !prodCsp["script-src"].includes("'unsafe-eval'"),
  { dev: devCsp["script-src"], prod: prodCsp["script-src"] },
);

check(
  "upgrade-insecure-requests applies in production only",
  "upgrade-insecure-requests" in prodCsp && !("upgrade-insecure-requests" in devCsp),
);

check(
  "a nonce is included when supplied",
  parseCsp(
    securityHeaders({ isProduction: true, nonce: "abc123" })["Content-Security-Policy"],
  )["script-src"].includes("'nonce-abc123'"),
);

// This is a known, documented gap rather than an accident. The test asserts the
// *current* state so that removing 'unsafe-inline' later is a deliberate change
// that updates this assertion, not a silent drift either way.
check(
  "script-src still needs unsafe-inline for Next's bootstrap (documented gap)",
  prodCsp["script-src"].includes("'unsafe-inline'"),
  prodCsp["script-src"],
);

// ---------------------------------------------------------------------------
section("Permissions-Policy");
// ---------------------------------------------------------------------------

{
  const policy = prod["Permissions-Policy"];

  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
    check(`${feature} is denied`, policy.includes(`${feature}=()`), policy);
  }

  check(
    "no feature is granted to a wildcard",
    !policy.includes("=*") && !policy.includes('=(")'),
    policy,
  );
}

// ---------------------------------------------------------------------------
section("Determinism");
// ---------------------------------------------------------------------------

{
  const first = JSON.stringify(securityHeaders({ isProduction: true }));
  let stable = true;

  for (let index = 0; index < 100; index += 1) {
    if (JSON.stringify(securityHeaders({ isProduction: true })) !== first) {
      stable = false;
      break;
    }
  }

  check("securityHeaders is deterministic", stable);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
