// docs/api/openapi.yaml must describe exactly the routes the handlers serve
// and API Gateway routes (src/api/routes.ts), with the right security.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACCOUNT_ROUTES, AUTH_ROUTES, DATA_ROUTES, REFRESH_COOKIE } from "../src/api/routes.js";
import { RESERVED_FIELDS } from "../src/data/index.js";

const text = readFileSync(new URL("../../docs/api/openapi.yaml", import.meta.url), "utf8");
const spec = parse(text) as {
  openapi: string;
  security: unknown;
  paths: Record<string, Record<string, { security?: unknown; operationId?: string; responses?: Record<string, Record<string, unknown>> }>>;
  components: { securitySchemes: Record<string, { name?: string }> };
};
const METHODS = ["get", "put", "patch", "delete", "post"];

const described = Object.entries(spec.paths)
  .flatMap(([path, item]) => Object.keys(item).filter((k) => METHODS.includes(k)).map((m) => `${m.toUpperCase()} ${path}`))
  .sort();

describe("OpenAPI description", () => {
  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  it("describes every route, and nothing else", () => {
    const served = [...DATA_ROUTES, ...ACCOUNT_ROUTES, ...AUTH_ROUTES].map((r) => `${r.method} ${r.path}`).sort();
    expect(described).toEqual(served);
  });

  it("needs a bearer token on data and account routes and not on auth routes", () => {
    expect(spec.security).toEqual([{ cognito: [] }]);
    for (const r of [...DATA_ROUTES, ...ACCOUNT_ROUTES]) expect(spec.paths[r.path]?.[r.method.toLowerCase()]?.security, r.path).toBeUndefined();
    for (const r of AUTH_ROUTES) expect(spec.paths[r.path]?.post?.security, r.path).not.toContainEqual({ cognito: [] });
    expect(spec.components.securitySchemes.refreshCookie?.name).toBe(REFRESH_COOKIE);
  });

  it("gives every operation a unique ID", () => {
    const ids = Object.values(spec.paths).flatMap((item) => METHODS.map((m) => item[m]?.operationId).filter(Boolean));
    expect(ids).toHaveLength(described.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every response a description or a reference, and nothing else", () => {
    for (const item of Object.values(spec.paths)) {
      for (const m of METHODS) {
        for (const response of Object.values(item[m]?.responses ?? {})) {
          const allowed = "$ref" in response ? ["$ref"] : ["description", "headers", "content"];
          expect(Object.keys(response).every((k) => allowed.includes(k)), JSON.stringify(response)).toBe(true);
          if (!("$ref" in response)) expect(typeof response.description).toBe("string");
        }
      }
    }
  });

  it("lists the server-owned fields the data layer refuses", () => {
    for (const field of RESERVED_FIELDS) expect(text).toContain(`\`${field}\``);
  });
});
