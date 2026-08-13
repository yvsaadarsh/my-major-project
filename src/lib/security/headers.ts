/**
 * Security response headers.
 *
 * Pure and dependency-free so the exact header set can be asserted in tests
 * rather than eyeballed in a browser devtools panel. The middleware applies
 * whatever this returns; it holds no policy of its own.
 */

export type SecurityHeaderOptions = {
  /**
   * True in production. Controls two things:
   * - HSTS is only sent over HTTPS (it is meaningless and confusing on http://localhost)
   * - the CSP omits the `unsafe-eval` that Next.js's dev-mode React refresh needs
   */
  isProduction: boolean;
  /** Per-request nonce, if the app ever adopts nonce-based script allowance. */
  nonce?: string;
};

/**
 * Content Security Policy.
 *
 * Honest note on `'unsafe-inline'` for scripts: Next.js's App Router injects
 * inline bootstrap and flight-data scripts on every server-rendered page. Until
 * those are nonce-tagged, a script-src without `'unsafe-inline'` breaks
 * hydration outright. We therefore keep it, and rely on the other directives
 * (no `object-src`, restricted `frame-ancestors`, restricted `connect-src`) to
 * do the real work. This is a known, documented gap rather than an oversight —
 * see docs/SECURITY.md.
 *
 * `style-src` also needs `'unsafe-inline'` because Tailwind v4 and the Next font
 * loader emit inline style attributes and blocks.
 */
function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const scriptSrc = ["'self'", "'unsafe-inline'"];

  // React Fast Refresh compiles with eval in development only.
  if (!options.isProduction) {
    scriptSrc.push("'unsafe-eval'");
  }

  if (options.nonce) {
    scriptSrc.push(`'nonce-${options.nonce}'`);
  }

  const directives: Array<[string, string[]]> = [
    // Nothing loads from anywhere unless a more specific directive allows it.
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // next/font/google inlines the font files at build time, so no remote host
    // is needed at runtime. data: covers inlined woff2.
    ["font-src", ["'self'", "data:"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    // The app only ever talks to its own API. No analytics, no third parties,
    // and no model providers: AI calls are made server-side by src/lib/ai, so
    // the browser still has no reason to reach Anthropic. If this directive ever
    // needs widening, a model call has leaked into the client — fix the call.
    ["connect-src", ["'self'"]],
    // No plugins, no Flash, no <object>.
    ["object-src", ["'none'"]],
    // We never embed anything, and nobody may embed us. This is the CSP-native
    // equivalent of X-Frame-Options: DENY and takes precedence where supported.
    ["frame-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    // Constrain <base href>, which can otherwise rewrite every relative URL.
    ["base-uri", ["'self'"]],
    // Forms may only submit back to us — blocks a injected form exfiltrating
    // credentials to an attacker's host.
    ["form-action", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["media-src", ["'self'"]],
    ["worker-src", ["'self'", "blob:"]],
  ];

  const policy = directives
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  // Silently rewrite any stray http:// subresource to https:// in production
  // rather than letting it load insecurely.
  return options.isProduction ? `${policy}; upgrade-insecure-requests` : policy;
}

/**
 * Permissions-Policy: deny every powerful feature we do not use.
 *
 * A project management tool has no business reading a camera or a payment
 * handler, and stating so explicitly means a future dependency cannot quietly
 * start asking.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** One year, the minimum for HSTS preload eligibility. */
const HSTS_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function securityHeaders(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(options),
    // Legacy belt-and-braces for browsers that predate frame-ancestors.
    "X-Frame-Options": "DENY",
    // Stop browsers from MIME-sniffing a response into something executable.
    "X-Content-Type-Options": "nosniff",
    // Send the origin cross-site, the full URL same-site. Prevents task and
    // project IDs from leaking in the Referer of any outbound link.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    // Keep this origin out of other sites' browsing-context groups.
    "Cross-Origin-Opener-Policy": "same-origin",
    // Do not let other origins read our responses opaquely.
    "Cross-Origin-Resource-Policy": "same-origin",
    // Legacy, harmless, and still requested by some scanners.
    "X-DNS-Prefetch-Control": "off",
  };

  if (options.isProduction) {
    headers["Strict-Transport-Security"] =
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`;
  }

  return headers;
}

export { HSTS_MAX_AGE_SECONDS, PERMISSIONS_POLICY };
