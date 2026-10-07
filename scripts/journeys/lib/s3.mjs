// The two journey buckets, through the AWS CLI (preinstalled on GitHub's runners) with the
// journeys role's credentials from the environment (aws-actions/configure-aws-credentials). The
// role may only list and read the mail bucket's inbox/ and runs/, delete under inbox/, write
// under runs/, and write under the results bucket's runs/ (docs/infrastructure.md, "Journey
// tests").
//
// The bucket name is an argument, never printed: the CLI's output is captured, and an error
// says only which operation failed, with the bucket and anything like an account ID redacted.
import { execFile } from "node:child_process";

const run = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile("aws", args, { maxBuffer: 64 * 1024 * 1024, encoding: "buffer", timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: stderr?.toString("utf8") ?? "" }));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });

/**
 * An S3 client for one bucket: list(prefix) → [{ key, lastModified }], get(key) → Buffer,
 * put(key, body), remove(key), upload(dir, prefix). `exec` is injectable for the unit tests.
 */
export function createS3(bucket, { exec = run } = {}) {
  const fail = (operation, err) => {
    const detail = String(err?.stderr ?? "").split(bucket).join("***").replace(/(?<![0-9])[0-9]{12}(?![0-9])/g, "***");
    const code = /\(([A-Za-z]+)\)/.exec(detail)?.[1];
    return new Error(`S3 ${operation} failed${code ? `: ${code}` : ""}`);
  };
  const wrap = (operation, fn) => async (...args) => {
    try { return await fn(...args); } catch (err) { throw fail(operation, err); }
  };
  return {
    list: wrap("list", async (prefix) => {
      const out = await exec(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix, "--output", "json"]);
      const json = out.length ? JSON.parse(out.toString("utf8")) : {};
      return (json.Contents ?? []).map((o) => ({ key: o.Key, lastModified: Date.parse(o.LastModified) }));
    }),
    get: wrap("get", (key) => exec(["s3", "cp", `s3://${bucket}/${key}`, "-", "--quiet"])),
    put: wrap("put", (key, body) => exec(["s3", "cp", "-", `s3://${bucket}/${key}`, "--quiet", "--content-type", "application/json"], body)),
    remove: wrap("delete", (key) => exec(["s3api", "delete-object", "--bucket", bucket, "--key", key])),
    upload: wrap("upload", (dir, prefix) => exec(["s3", "cp", dir, `s3://${bucket}/${prefix}`, "--recursive", "--quiet", "--only-show-errors"])),
  };
}
