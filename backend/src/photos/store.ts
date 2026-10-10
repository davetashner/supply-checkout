// The photos bucket (supply-checkout-6uw.30): one object per stored photo,
// `photos/<photoId>.jpg`, private (Block Public Access, bucket-owner-enforced
// ownership), written, read and deleted only by the account function's own
// role, under photos/* only (infra/lib/stacks/api-stack.ts).
//
// Teammates see a photo through a presigned GET URL that lasts PHOTO_URL_SECONDS
// (or less: never past the role session's own credentials). The URL is
// signed here, with no network call, and makes S3 answer with
// `Content-Type: image/jpeg`, `Content-Disposition: inline` and
// `Cache-Control: private, max-age=3600` whatever the object says. It's a
// bearer link, so it's never logged.

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import { PHOTO_ID, PHOTO_PREFIX, PHOTOS_ENV, photosHost } from "./names.js";

/** How long a presigned photo URL lasts. The app refetches /photos before then, or when an image fails to load. */
export const PHOTO_URL_SECONDS = 3600;

/** What S3 answers a presigned GET with, whatever the stored object's own metadata says. */
export const PHOTO_RESPONSE_HEADERS = {
  "response-cache-control": "private, max-age=3600",
  "response-content-disposition": "inline",
  "response-content-type": "image/jpeg",
} as const;

/** Stores, deletes and links photos by ID. */
export interface PhotoStore {
  put(photoId: string, jpeg: Buffer): Promise<void>;
  /** Idempotent: deleting a photo that isn't there succeeds. */
  delete(photoId: string): Promise<void>;
  /** A presigned GET URL for the photo, good for PHOTO_URL_SECONDS. */
  url(photoId: string): Promise<string>;
}

/** The S3 calls this module makes; an S3Client, or a fake in tests. */
export interface PhotoS3 {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

const REGION = /^[a-z0-9-]+$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const Sha256 = Hash.bind(null, "sha256");

/** The object key for a photo ID, or a throw: nothing else in the bucket is ever named. */
export function photoKey(photoId: string): string {
  if (typeof photoId !== "string" || !PHOTO_ID.test(photoId)) throw new Error("Invalid photo ID");
  return `${PHOTO_PREFIX}${photoId}.jpg`;
}

/** The header that names a presigned GET's payload hash: read for the signature, never sent or signed. */
const PAYLOAD = "x-amz-content-sha256";

/**
 * Signs a presigned S3 GET: paths as they are (S3 doesn't double-escape), an
 * UNSIGNED-PAYLOAD, and only the host header signed. Returns the URL's query.
 */
export function presignGet(options: { readonly region: string; readonly credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider }) {
  const signer = new SignatureV4({ service: "s3", region: options.region, credentials: options.credentials, sha256: Sha256, uriEscapePath: false, applyChecksum: false });
  return async (host: string, path: string, query: Record<string, string>, expiresIn: number, signingDate: Date): Promise<Record<string, string>> => {
    const signed = await signer.presign(
      { method: "GET", protocol: "https:", hostname: host, path, headers: { host, [PAYLOAD]: "UNSIGNED-PAYLOAD" }, query: { ...query } },
      { expiresIn, signingDate, unsignableHeaders: new Set([PAYLOAD]), unhoistableHeaders: new Set([PAYLOAD]) },
    );
    return Object.fromEntries(Object.entries(signed.query ?? {}).map(([k, v]) => [k, String(v)]));
  };
}

export interface PhotoStoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly s3?: PhotoS3;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  readonly now?: () => number;
}

export function s3PhotoStore(options: PhotoStoreOptions): PhotoStore {
  if (!BUCKET.test(options.bucket)) throw new Error("Not an S3 bucket name");
  if (!REGION.test(options.region)) throw new Error("Not an AWS region name");
  const { bucket, region } = options;
  const s3 = options.s3 ?? new S3Client({ region });
  const host = photosHost(bucket, region);
  const now = options.now ?? Date.now;
  const presign = presignGet({ region, credentials: options.credentials ?? defaultProvider() });

  return {
    async put(photoId, jpeg) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: photoKey(photoId), Body: jpeg, ContentType: "image/jpeg", ContentDisposition: "inline", CacheControl: "private, max-age=3600" }),
      );
    },
    async delete(photoId) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: photoKey(photoId) }));
    },
    async url(photoId) {
      const path = `/${photoKey(photoId)}`;
      const signed = await presign(host, path, { ...PHOTO_RESPONSE_HEADERS }, PHOTO_URL_SECONDS, new Date(now()));
      const query = Object.entries(signed)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      return `https://${host}${path}?${query}`;
    },
  };
}

/** The photo store for a Lambda: PHOTOS_BUCKET, in PHOTOS_REGION. Fails closed when either isn't set. */
export function photoStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PhotoStore {
  const bucket = env[PHOTOS_ENV.bucket];
  const region = env[PHOTOS_ENV.region];
  if (!bucket || !region) throw new Error(`${PHOTOS_ENV.bucket} and ${PHOTOS_ENV.region} must be set`);
  return s3PhotoStore({ bucket, region });
}
