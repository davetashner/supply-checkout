// The Content-Security-Policy CloudFront sends with the operator page at ops.<env domain>
// (supply-checkout-gxlt, ADR 0015 §6). No imports, so the Playwright suite can load it too:
// tests/ops.spec.js serves the page with this header and fails on any violation.
//
// Much stricter than the customer app's (content-security-policy.ts), because the page holds
// an operator's token and has nothing else to load:
// - default-src 'none': everything not listed is refused.
// - Its own hashed script, stylesheet and icon only ('self'): no inline script or style, no
//   style attributes, no fonts, no data: or blob: URLs.
// - connect-src: only the API (the /ops routes) and the operator pool's sign-in host (the token
//   endpoint). 'self' too, for ops-config.json. Not the customers' auth. or realtime. hosts.
// - Trusted Types are required, so a script can't write HTML into the page (the page only ever
//   uses textContent; an innerHTML assignment would throw). Browsers without Trusted Types
//   ignore both directives, and the rest still applies.
// - No frames (frame-ancestors 'none', also X-Frame-Options DENY), no <base>, no forms posting
//   anywhere (the page's forms are handled in script), no plugins, no workers, no manifest.

export interface OpsCspHosts {
  /** api.<env domain> */
  readonly api: string;
  /** ops-auth.<env domain>: the operator pool's Managed Login and OAuth endpoints. */
  readonly opsAuth: string;
}

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function opsCspDirectives(hosts: OpsCspHosts): Record<string, string[]> {
  for (const host of [hosts.api, hosts.opsAuth]) {
    if (!HOST.test(host)) throw new Error(`Ops CSP: "${host}" isn't a lowercase host name`);
  }
  return {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "img-src": ["'self'"],
    "connect-src": ["'self'", `https://${hosts.api}`, `https://${hosts.opsAuth}`],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    // No workers of any kind (worker-src would otherwise fall back to script-src 'self')
    "worker-src": ["'none'"],
    "manifest-src": ["'none'"],
    "require-trusted-types-for": ["'script'"],
    "trusted-types": ["'none'"],
    "upgrade-insecure-requests": [],
  };
}

export function opsContentSecurityPolicy(hosts: OpsCspHosts): string {
  return Object.entries(opsCspDirectives(hosts))
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}
