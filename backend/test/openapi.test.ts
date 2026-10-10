// docs/api/openapi.yaml must describe exactly the routes the handlers serve
// and API Gateway routes (src/api/routes.ts), with the right security.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACCOUNT_ROUTES, AUTH_ROUTES, BILLING_ROUTES, DATA_ROUTES, OPS_ROUTES, PASSWORD_RESET_ROUTES, RECEIPT_ROUTES, REFRESH_COOKIE, WEBHOOK_ROUTES } from "../src/api/routes.js";
import { BILLING_EVENTS } from "../src/billing/names.js";
import { BILLING_INTERVALS, CATALOG } from "../src/billing/catalog.js";
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
    const served = [...DATA_ROUTES, ...RECEIPT_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES, ...WEBHOOK_ROUTES, ...AUTH_ROUTES, ...PASSWORD_RESET_ROUTES, ...OPS_ROUTES].map((r) => `${r.method} ${r.path}`).sort();
    expect(described).toEqual(served);
  });

  it("needs a bearer token on data, account and billing routes and not on auth routes", () => {
    expect(spec.security).toEqual([{ cognito: [] }]);
    for (const r of [...DATA_ROUTES, ...RECEIPT_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES]) expect(spec.paths[r.path]?.[r.method.toLowerCase()]?.security, r.path).toBeUndefined();
    for (const r of AUTH_ROUTES) expect(spec.paths[r.path]?.post?.security, r.path).not.toContainEqual({ cognito: [] });
    // Password resets: no token or cookie at all (an Origin check)
    for (const r of PASSWORD_RESET_ROUTES) expect(spec.paths[r.path]?.post?.security, r.path).toEqual([]);
    // Stripe's webhook: the Stripe signature only
    for (const r of WEBHOOK_ROUTES) expect(spec.paths[r.path]?.post?.security, r.path).toEqual([]);
    expect(spec.components.securitySchemes.refreshCookie?.name).toBe(REFRESH_COOKIE);
  });

  it("needs an operator-pool token, and only that, on every ops route", () => {
    for (const r of OPS_ROUTES) expect(spec.paths[r.path]?.[r.method.toLowerCase()]?.security, r.path).toEqual([{ opsCognito: [] }]);
    expect(spec.components.securitySchemes.opsCognito).toBeDefined();
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

  it("offers exactly the catalog's plans and intervals at checkout, and no seat count (the server's, supply-checkout-8jc.20)", () => {
    const body = (spec.paths["/teams/{teamId}/billing/checkout"]?.post as unknown as { requestBody: { content: { "application/json": { schema: { properties: Record<string, { enum?: string[]; maximum?: number }> } } } } }).requestBody.content["application/json"].schema.properties;
    expect(body.plan?.enum).toEqual(CATALOG.plans.map((p) => p.plan));
    expect(body.interval?.enum).toEqual([...BILLING_INTERVALS]);
    expect(Object.keys(body)).toEqual(["plan", "interval"]);
  });

  it("names every Stripe event the webhook handles", () => {
    const description = String((spec.paths["/billing/webhook"]?.post as unknown as { description: string }).description).replace(/\s+/g, " ");
    for (const type of BILLING_EVENTS) expect(description).toContain(type.startsWith("customer.subscription.") && type !== "customer.subscription.created" ? `.${type.split(".").at(-1)}` : type);
  });

  it("lists every error code and reason the handlers send", () => {
    const http = readFileSync(new URL("../src/api/http.ts", import.meta.url), "utf8");
    const union = (name: string) => [...(new RegExp(`export type ${name} =([^;]+);`).exec(http)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const error = (spec.components as unknown as { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] }; reason: { enum: string[] } } } } } } }).schemas.Error.properties.error.properties;
    expect(error.code.enum.slice().sort()).toEqual(union("ErrorCode").sort());
    expect(error.reason.enum.slice().sort()).toEqual(union("ErrorReason").sort());
  });

  it("lists the server-owned fields the data layer refuses", () => {
    for (const field of RESERVED_FIELDS) expect(text).toContain(`\`${field}\``);
  });

  it("describes an operator audit event's before and after as one of its recorded shapes (supply-checkout-6uw.9)", () => {
    const schemas = (spec.components as unknown as { schemas: Record<string, { oneOf?: unknown[]; required?: string[]; properties?: Record<string, unknown>; additionalProperties?: unknown }> }).schemas;
    const ref = { $ref: "#/components/schemas/AuditRecord" };
    const eventItems = (path: string, list: string) =>
      ((spec.paths[path]?.get?.responses?.["200"] as { content: Record<string, { schema: { properties: Record<string, { items: { properties: Record<string, unknown> } }> } }> }).content["application/json"]?.schema.properties[list]?.items.properties);
    for (const [path, list] of [["/ops/audit", "events"], ["/teams/{teamId}/support-actions", "actions"]]) {
      const props = eventItems(path as string, list as string);
      expect(props?.before, path).toEqual(ref);
      expect(props?.after, path).toEqual(ref);
    }
    expect(schemas.AuditRecord?.oneOf).toEqual([
      { $ref: "#/components/schemas/CompRecord" },
      { $ref: "#/components/schemas/CompMonthsRecord" },
      { $ref: "#/components/schemas/CompDiscountBefore" },
      { $ref: "#/components/schemas/CompDiscountRecord" },
      { $ref: "#/components/schemas/ImportClearRecord" },
      { $ref: "#/components/schemas/ReopenRecord" },
      { $ref: "#/components/schemas/TeamsListRecord" },
      { $ref: "#/components/schemas/ReceiptUsageRecord" },
      { $ref: "#/components/schemas/FeedbackListRecord" },
      { $ref: "#/components/schemas/FeedbackReadRecord" },
      { $ref: "#/components/schemas/FeedbackStatusBefore" },
      { $ref: "#/components/schemas/FeedbackStatusRecord" },
      { type: "null" },
    ]);
    // Each shape is closed and fully required, so exactly one matches any recorded value (backend/test/ops-api.test.ts checks real ones)
    for (const [name, keys] of Object.entries(AUDIT_RECORD_SHAPES)) {
      const schema = schemas[name];
      expect(schema?.additionalProperties, name).toBe(false);
      expect(schema?.required, name).toEqual(keys);
      expect(Object.keys(schema?.properties ?? {}), name).toEqual(keys);
    }
  });
});

/** The operator audit's before and after shapes (data/operator.ts), by their docs/api/openapi.yaml schema name. */
const AUDIT_RECORD_SHAPES: Record<string, string[]> = {
  CompRecord: ["plan", "seats", "until", "reason"],
  CompMonthsRecord: ["plan", "seats", "until", "reason", "months"],
  CompDiscountBefore: ["coupon"],
  CompDiscountRecord: ["outcome", "coupon", "until", "subscriptionId"],
  ImportClearRecord: ["importId", "committing"],
  ReopenRecord: ["closedAt", "purgeAfter"],
  TeamsListRecord: ["q", "cursor", "teams"],
  ReceiptUsageRecord: ["month", "teams"],
  FeedbackListRecord: ["status", "cursor", "reports"],
  FeedbackReadRecord: ["status", "emailLookup"],
  FeedbackStatusBefore: ["status"],
  FeedbackStatusRecord: ["status", "beadId"],
};
