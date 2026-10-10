// The photos bucket's client (src/photos/store.ts, supply-checkout-6uw.30):
// the keys it may name, what it writes, and the presigned URLs it gives out.

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { GLOBAL_SERVICES_REGION } from "../../infra/lib/config.js";
import { REGION } from "./helpers.js";
import { PHOTO_PREFIX, PHOTOS_ENV, photosBucketName, photosHost } from "../src/photos/names.js";
import { PHOTO_RESPONSE_HEADERS, PHOTO_URL_SECONDS, photoKey, photoStoreFromEnv, presignGet, s3PhotoStore } from "../src/photos/store.js";

const ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "supply-checkout-test-photos-test-local-1-000000000000";
const CREDENTIALS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: "session+token/=" }; // public-safety: allow (AWS's documented example key)
const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function fakeS3() {
  const sent: (PutObjectCommand | DeleteObjectCommand)[] = [];
  return { sent, s3: { send: async (c: PutObjectCommand | DeleteObjectCommand) => void sent.push(c) } };
}

describe("photo keys", () => {
  it("are photos/<id>.jpg for a 128-bit hex ID, and nothing else", () => {
    expect(photoKey(ID)).toBe(`${PHOTO_PREFIX}${ID}.jpg`);
    for (const bad of ["", "../x", `${ID}0`, ID.toUpperCase(), `${ID.slice(1)}/`, "user-pat", undefined as unknown as string]) expect(() => photoKey(bad)).toThrow("Invalid photo ID");
  });

  it("are in a bucket named for the environment, region and account, at its regional host", () => {
    expect(photosBucketName("prod", REGION, "123")).toBe(`supply-checkout-prod-photos-${REGION}-123`);
    expect(photosHost("b", REGION)).toBe(`b.s3.${REGION}.amazonaws.com`);
  });
});

describe("s3PhotoStore", () => {
  it("puts a photo as an image/jpeg under its key, and deletes it by key", async () => {
    const { sent, s3 } = fakeS3();
    const store = s3PhotoStore({ bucket: BUCKET, region: "test-local-1", s3, credentials: CREDENTIALS });
    await store.put(ID, Buffer.from([1, 2, 3]));
    await store.delete(ID);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]?.input).toEqual({ Bucket: BUCKET, Key: `photos/${ID}.jpg`, Body: Buffer.from([1, 2, 3]), ContentType: "image/jpeg", ContentDisposition: "inline", CacheControl: "private, max-age=3600" });
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[1]?.input).toEqual({ Bucket: BUCKET, Key: `photos/${ID}.jpg` });
    await expect(store.put("../../other", Buffer.alloc(1))).rejects.toThrow("Invalid photo ID");
    await expect(store.delete("x")).rejects.toThrow("Invalid photo ID");
    expect(sent).toHaveLength(2);
  });

  it("refuses a bucket or region that isn't one", () => {
    expect(() => s3PhotoStore({ bucket: "Bad_Bucket", region: REGION, s3: fakeS3().s3 })).toThrow("bucket");
    expect(() => s3PhotoStore({ bucket: BUCKET, region: "us east 1", s3: fakeS3().s3 })).toThrow("region");
  });

  it("presigns a GET for an hour at the bucket's regional host, with S3 told to answer it as an inline image/jpeg", async () => {
    const store = s3PhotoStore({ bucket: BUCKET, region: "test-local-1", s3: fakeS3().s3, credentials: CREDENTIALS, now: () => NOW });
    const url = new URL(await store.url(ID));
    expect(url.origin).toBe(`https://${BUCKET}.s3.test-local-1.amazonaws.com`);
    expect(url.pathname).toBe(`/photos/${ID}.jpg`);
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({
      ...PHOTO_RESPONSE_HEADERS,
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKIAIOSFODNN7EXAMPLE/20261009/test-local-1/s3/aws4_request", // public-safety: allow
      "X-Amz-Date": "20261009T120000Z",
      "X-Amz-Expires": String(PHOTO_URL_SECONDS),
      "X-Amz-SignedHeaders": "host",
      "X-Amz-Security-Token": "session+token/=",
    });
    expect(query["X-Amz-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // The payload hash header is neither sent nor signed
    expect(Object.keys(query).map((k) => k.toLowerCase())).not.toContain("x-amz-content-sha256");
    expect(PHOTO_URL_SECONDS).toBe(3600);
    await expect(store.url("not-an-id")).rejects.toThrow("Invalid photo ID");
  });

  it("signs exactly as AWS's own presigned URL example does", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html, in the example's region (GLOBAL_SERVICES_REGION is it)
    const sign = presignGet({ region: GLOBAL_SERVICES_REGION, credentials: { accessKeyId: CREDENTIALS.accessKeyId, secretAccessKey: CREDENTIALS.secretAccessKey } });
    const query = await sign("examplebucket.s3.amazonaws.com", "/test.txt", {}, 86400, new Date("2013-05-24T00:00:00Z"));
    expect(query["X-Amz-Signature"]).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

describe("photoStoreFromEnv", () => {
  it("fails closed without the bucket and its region", () => {
    expect(() => photoStoreFromEnv({})).toThrow(PHOTOS_ENV.bucket);
    expect(() => photoStoreFromEnv({ [PHOTOS_ENV.bucket]: BUCKET })).toThrow(PHOTOS_ENV.region);
    expect(photoStoreFromEnv({ [PHOTOS_ENV.bucket]: BUCKET, [PHOTOS_ENV.region]: "test-local-1" })).toHaveProperty("url");
  });
});
