// Only the auth routes read cookies (supply-checkout-gxlt). The HTTP API's CORS allows credentials
// for the operator page's origin (ops.) on every route's responses, because CORS settings are per
// API, not per route; that's safe only while no route but the auth routes reads a cookie, and they
// check Origin against ALLOWED_ORIGINS (app. only) before reading the refresh cookie.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "../src/api/routes.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

describe("cookies", () => {
  it("are read only by the auth handler", () => {
    const readers = files(join(root, "src"))
      .filter((file) => /\.cookies\b|\[\s*["']cookies["']\s*\]|["']cookie["']/i.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).split("\\").join("/"));
    expect(readers).toEqual(["src/api/auth-handler.ts"]);
  });

  it("the refresh cookie is host-only on api., under /auth, Secure, HttpOnly and SameSite=Strict", () => {
    const source = readFileSync(join(root, "src/api/auth-handler.ts"), "utf8");
    expect(REFRESH_COOKIE_PATH).toBe("/auth");
    expect(REFRESH_COOKIE.startsWith("__Secure-")).toBe(true);
    const sets = [...source.matchAll(/`\$\{REFRESH_COOKIE\}=[^`]*`/g)].map((m) => m[0]);
    expect(sets.length).toBe(2);
    for (const set of sets) {
      expect(set).toContain("Path=${REFRESH_COOKIE_PATH}");
      expect(set).toMatch(/HttpOnly; Secure; SameSite=Strict/);
      expect(set).not.toMatch(/Domain=/i);
    }
  });
});
