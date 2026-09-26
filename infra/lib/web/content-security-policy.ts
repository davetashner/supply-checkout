// The Content-Security-Policy CloudFront sends with the web app and the demo
// (supply-checkout-qk1). No imports, so the Playwright suite can load it too:
// tests/content-security-policy.spec.js serves each build with this header and
// fails on any violation.
//
// What the app loads today (src/index.html):
// - Google Fonts: the stylesheet from fonts.googleapis.com, the font files from
//   fonts.gstatic.com.
// - ZXing from cdn.jsdelivr.net (a classic script tag, pinned version).
// - Its own hashed script, stylesheet and favicons (src/icons/).
// - Inline style="" attributes in markup that src/main.js renders with
//   innerHTML, hence style-src-attr 'unsafe-inline'. <style> elements and
//   inline scripts stay blocked.
// - blob: images: barcode.js reads a photo through URL.createObjectURL.
// The API, realtime and sign-in hosts are allowed for connections ahead of the
// real app (ADR 0006, 0007).

export interface CspHosts {
  readonly api: string;
  readonly realtime: string;
  readonly auth: string;
}

export function cspDirectives(hosts: CspHosts): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://cdn.jsdelivr.net"],
    "style-src": ["'self'", "https://fonts.googleapis.com"],
    "style-src-attr": ["'unsafe-inline'"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": ["'self'", `https://${hosts.api}`, `https://${hosts.realtime}`, `wss://${hosts.realtime}`, `https://${hosts.auth}`],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "upgrade-insecure-requests": [],
  };
}

export function contentSecurityPolicy(hosts: CspHosts): string {
  return Object.entries(cspDirectives(hosts))
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}
