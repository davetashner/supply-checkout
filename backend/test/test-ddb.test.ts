// npm run test:ddb (scripts/test-ddb.ts), driven through a fake `docker` on a
// PATH that holds only it and node, so no container runtime is needed.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ciImage, INSTALL_HELP } from "../scripts/test-ddb.js";

const SCRIPT = fileURLToPath(new URL("../scripts/test-ddb.ts", import.meta.url));

// Logs every call. `info` works only when FAKE_INFO says so ("current" or
// "colima"), `port` prints FAKE_PORT, and `run` prints a container ID.
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "info") [ "$FAKE_INFO" = current ] ;;
  "context inspect colima") [ "$FAKE_INFO" = colima ] ;;
  "--context colima info") [ "$FAKE_INFO" = colima ] ;;
  *" run "*|"run "*) echo c0ffee ;;
  *" port "*|"port "*) echo "127.0.0.1:$FAKE_PORT" ;;
  *) exit 0 ;;
esac
`;

let dir: string;
let bin: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "test-ddb-"));
  bin = join(dir, "bin");
  writeFileSync(join(dir, "log"), "");
  // Only node on PATH: no docker, no podman
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
});

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function addFakeDocker() {
  const path = join(bin, "docker");
  writeFileSync(path, FAKE_DOCKER);
  chmodSync(path, 0o755);
}

const log = () => readFileSync(join(dir, "log"), "utf8").trim().split("\n").filter(Boolean);

function start(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { PATH: bin, HOME: dir, FAKE_LOG: join(dir, "log"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const done = new Promise<{ code: number | null; output: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, output })),
  );
  return { child, done };
}

/** Something answering HTTP, standing in for DynamoDB Local. */
async function fakeDynamo(): Promise<string> {
  const listening = createServer((_req, res) => res.writeHead(400).end());
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return String((listening.address() as AddressInfo).port);
}

describe("npm run test:ddb", () => {
  it("uses the DynamoDB Local image from the CI workflow", () => {
    expect(ciImage()).toMatch(/^amazon\/dynamodb-local:\d+\.\d+\.\d+$/);
    expect(() => ciImage("jobs: {}")).toThrow(/dynamodb\.image/);
  });

  it("is the image the nightly future-clock job uses too", () => {
    const workflow = parse(readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8"));
    expect(workflow.jobs["backend-future"].services.dynamodb.image).toBe(ciImage());
  });

  it("explains how to install a runtime when there's none", async () => {
    const { code, output } = await start([]).done;
    expect(code).toBe(1);
    expect(output).toContain(INSTALL_HELP);
    expect(output).toContain("brew install colima docker && colima start");
    expect(log()).toEqual([]);
  });

  it("explains how to install a runtime when docker's daemon isn't running", async () => {
    addFakeDocker();
    const { code, output } = await start([], { FAKE_INFO: "none" }).done;
    expect(code).toBe(1);
    expect(output).toContain("brew install colima docker && colima start");
    expect(log()).not.toContainEqual(expect.stringMatching(/run /));
  });

  it("runs vitest against the container and removes it afterwards", async () => {
    addFakeDocker();
    const port = await fakeDynamo();
    const { code, output } = await start(["--passWithNoTests", "no-such-test-file"], { FAKE_INFO: "current", FAKE_PORT: port }).done;
    expect(output).toContain(`DynamoDB Local (${ciImage()}) is at http://127.0.0.1:${port}`);
    expect(code).toBe(0);
    expect(log()).toEqual([
      "info",
      `run -d --rm -p 127.0.0.1::8000 ${ciImage()}`,
      "port c0ffee 8000/tcp",
      "rm -f c0ffee",
    ]);
  });

  it("uses colima's docker context and passes on a failing test run", async () => {
    addFakeDocker();
    const port = await fakeDynamo();
    const { code } = await start(["no-such-test-file"], { FAKE_INFO: "colima", FAKE_PORT: port }).done;
    expect(code).not.toBe(0);
    expect(log()).toContain(`--context colima run -d --rm -p 127.0.0.1::8000 ${ciImage()}`);
    expect(log().at(-1)).toBe("--context colima rm -f c0ffee");
  });

  it("removes the container on Ctrl-C", async () => {
    addFakeDocker();
    // Nothing listens on this port, so the script keeps waiting
    const port = await fakeDynamo();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    const { child, done } = start([], { FAKE_INFO: "current", FAKE_PORT: port });
    await expect.poll(log).toContain("port c0ffee 8000/tcp");
    child.kill("SIGINT");
    expect((await done).code).toBe(130);
    expect(log().at(-1)).toBe("rm -f c0ffee");
  });
});
