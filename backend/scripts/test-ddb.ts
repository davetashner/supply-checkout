// npm run test:ddb: runs the backend tests against DynamoDB Local in a
// container, as CI does, so the suites guarded by DYNAMODB_ENDPOINT run
// locally too. The image comes from the CI workflow's backend service, so the
// two can't drift apart. Extra arguments go to vitest:
//
//   npm run test:ddb -- test/documents.test.ts
//
// Needs a container runtime: Docker with a running daemon (Docker Desktop, or
// colima's docker context) or Podman. It never installs one.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const BACKEND = fileURLToPath(new URL("..", import.meta.url));
const CI_WORKFLOW = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const WAIT_SECONDS = 30;

export const INSTALL_HELP = `No container runtime is available to run DynamoDB Local.
Start Docker Desktop, or install and start colima (macOS):

  brew install colima docker && colima start

then run npm run test:ddb again.`;

/** The DynamoDB Local image CI uses, e.g. amazon/dynamodb-local:3.0.0. */
export function ciImage(workflow = readFileSync(CI_WORKFLOW, "utf8")): string {
  const image: unknown = parse(workflow)?.jobs?.backend?.services?.dynamodb?.image;
  if (typeof image !== "string" || !image) throw new Error(`No jobs.backend.services.dynamodb.image in ${CI_WORKFLOW}`);
  return image;
}

const run = ([cmd, ...args]: [string, ...string[]], timeout = 15_000) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
const works = (cmd: [string, ...string[]]) => run(cmd).status === 0;

/**
 * The first runtime whose daemon answers: docker in its current context, docker
 * in colima's context (when another context is selected), then podman.
 */
export function findRuntime(): [string, ...string[]] | undefined {
  const candidates: [string, ...string[]][] = [["docker"], ["docker", "--context", "colima"], ["podman"]];
  return candidates.find((cli) => {
    if (cli.includes("colima") && !works(["docker", "context", "inspect", "colima"])) return false;
    return works([...cli, "info"]);
  });
}

async function waitUntilAnswering(endpoint: string): Promise<boolean> {
  for (let i = 0; i < WAIT_SECONDS; i++) {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      return true; // any HTTP answer, as in CI
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return false;
}

async function main(args: string[]): Promise<number> {
  const runtime = findRuntime();
  if (!runtime) {
    console.error(INSTALL_HELP);
    return 1;
  }
  const image = ciImage();

  // Publish on a free port on localhost, chosen by the runtime
  const started = run([...runtime, "run", "-d", "--rm", "-p", "127.0.0.1::8000", image], 300_000);
  const id = started.stdout.trim();
  if (started.status !== 0 || !id) {
    console.error(`Could not start ${image}:\n${started.stderr}`);
    return 1;
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    run([...runtime, "rm", "-f", id], 60_000);
  };
  let child: ReturnType<typeof spawn> | undefined;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      child?.kill(signal);
      stop();
      process.exit(code);
    });
  }

  try {
    const port = /:(\d+)\s*$/m.exec(run([...runtime, "port", id, "8000/tcp"]).stdout)?.[1];
    if (!port) {
      console.error(`Could not find the port ${image} was published on.`);
      return 1;
    }
    const endpoint = `http://127.0.0.1:${port}`;
    if (!(await waitUntilAnswering(endpoint))) {
      console.error(`DynamoDB Local did not answer at ${endpoint} within ${WAIT_SECONDS}s.`);
      return 1;
    }
    console.log(`DynamoDB Local (${image}) is at ${endpoint}`);
    return await new Promise<number>((resolve) => {
      child = spawn(process.execPath, [VITEST, "run", ...args], {
        cwd: BACKEND,
        stdio: "inherit",
        env: { ...process.env, DYNAMODB_ENDPOINT: endpoint },
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
