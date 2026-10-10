// The Content-Security-Policy CloudFront sends with the web app and the demo
// (supply-checkout-qk1). No imports, so the Playwright suite can load it too:
// tests/content-security-policy.spec.js serves each build with this header and
// fails on any violation.
//
// What the app loads today (src/index.html):
// - Google Fonts: the stylesheet from fonts.googleapis.com, the font files from
//   fonts.gstatic.com.
// - Its own hashed scripts (including ZXing, bundled from npm and loaded when a
//   photo needs it), stylesheet and favicons (src/icons/). No third-party scripts.
// - Inline style="" attributes in markup that src/main.js renders with
//   innerHTML, hence style-src-attr 'unsafe-inline'. <style> elements and
//   inline scripts stay blocked.
// - blob: images: barcode.js reads a photo through URL.createObjectURL.
// - Profile photos (supply-checkout-6uw.30): presigned GET URLs at the photos
//   bucket's regional host (backend/src/photos/names.ts photosHost), that one
//   bucket only, not *.amazonaws.com. The web stack passes it in, as this file
//   has no imports.
// - No web workers or service workers (ZXing decodes on the main thread), so
//   worker-src is 'none'.
// The API, realtime and sign-in hosts are allowed for connections ahead of the
// real app (ADR 0006, 0007).
// CloudWatch RUM (web/rum.ts, src/aws/rum.js): the RUM client is bundled from npm,
// so no script host; it gets guest credentials from Cognito identity pools
// (cognito-identity.<region>) and sends events to the RUM data plane
// (dataplane.rum.<region>), both in the app monitor's region.

export interface CspHosts {
  readonly api: string;
  readonly realtime: string;
  readonly auth: string;
  /** The RUM app monitor's region (the web stack's). */
  readonly rumRegion: string;
  /** The profile photos bucket's host, `<bucket>.s3.<region>.amazonaws.com` (the bucket name may hold the account ID's token). */
  readonly photos: string;
}

export function cspDirectives(hosts: CspHosts): Record<string, string[]> {
  // A literal region name, never an unresolved CDK token
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(hosts.rumRegion)) throw new Error(`CSP: "${hosts.rumRegion}" isn't a region name`);
  // One S3 bucket's own host, never a wildcard or a list
  if (!/^[^\s;,*'"]+\.s3\.[a-z]{2}(-[a-z]+)+-\d+\.amazonaws\.com$/.test(hosts.photos)) throw new Error(`CSP: "${hosts.photos}" isn't an S3 bucket's regional host`);
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "https://fonts.googleapis.com"],
    "style-src-attr": ["'unsafe-inline'"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", `https://${hosts.photos}`],
    "connect-src": [
      "'self'",
      `https://${hosts.api}`,
      `https://${hosts.realtime}`,
      `wss://${hosts.realtime}`,
      `https://${hosts.auth}`,
      `https://cognito-identity.${hosts.rumRegion}.amazonaws.com`,
      `https://dataplane.rum.${hosts.rumRegion}.amazonaws.com`,
    ],
    "manifest-src": ["'self'"],
    "worker-src": ["'none'"],
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
