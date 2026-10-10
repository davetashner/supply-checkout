// Names the profile photos code and the CDK app share (infra/lib/stacks/data-stack.ts,
// api-stack.ts and web/content-security-policy.ts import this file), so the
// bucket, the grant, the Content-Security-Policy and the presigned URLs can't
// drift apart. No imports.

/**
 * The primary region's bucket of profile photos (supply-checkout-6uw.30). The
 * account ID makes the name globally unique.
 */
export function photosBucketName(envName: string, region: string, account: string): string {
  return `supply-checkout-${envName}-photos-${region}-${account}`;
}

/**
 * The bucket's regional virtual-hosted host, which every presigned URL names
 * and the web app's img-src allows (and nothing else of S3).
 */
export function photosHost(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

/** Every photo is `photos/<photoId>.jpg`; the account function may touch nothing else in the bucket. */
export const PHOTO_PREFIX = "photos/";

/** A photo's ID: 128 random bits as hex, new for each upload. No user ID, name or email in it. */
export const PHOTO_ID = /^[0-9a-f]{32}$/;

/** Environment variables the account function reads. */
export const PHOTOS_ENV = {
  /** The bucket (photosBucketName). */
  bucket: "PHOTOS_BUCKET",
  /** The bucket's region: the primary region, wherever the function runs. */
  region: "PHOTOS_REGION",
} as const;
