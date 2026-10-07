// Runs the app locally against the same in-memory runtime the tests use, so
// it can be tried in a browser without signing in.
//
//   npm run dev                      http://localhost:5173
//   PORT=8080 npm run dev
//
// Query string options:
//   ?seed=empty                      start with no sheets or inventory
//   ?viewer                          view-only access
//   ?nouser                          no signed-in user (asks who prepared sheets)
//   ?mock={"sampleError":"rate_limited"}
//                                    any tests/mock-claude.js option, as JSON
//
// Data lives in memory in the page: a reload starts over. The app is served
// from src/ by Vite's dev server, so edits reload the page.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";
import { demoState } from "../demo/data.js";
import { installMockClaude } from "../tests/mock-claude.js";

const PORT = Number(process.env.PORT) || 5173;
const demo = demoState();

// Runs in the page before the app's script: picks options from the URL and
// installs the mock runtime.
const bootstrap = `<script>
(() => {
  const q = new URLSearchParams(location.search);
  const opts = q.get("seed") === "empty" ? { receipt: ${JSON.stringify(demo.receipt)} } : ${JSON.stringify(demo)};
  if (q.has("viewer")) opts.canWrite = false;
  if (q.has("nouser")) opts.unavailable = ["user"];
  if (q.has("mock")) Object.assign(opts, JSON.parse(q.get("mock")));
  (${installMockClaude.toString()})(opts);
  console.info("Supply Checkout dev runtime", opts);
})();
</script>
`;

const root = fileURLToPath(new URL("../src/", import.meta.url));

// Exported so tests can run it on a free port. Closing the server also stops Vite.
export async function createDevServer() {
  let vite;
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/") { vite.middlewares(req, res, () => res.writeHead(404).end()); return; }
    try {
      // The bootstrap goes first in <head>, before any of the app's code
      const source = readFileSync(root + "index.html", "utf8").replace(/(<meta name="viewport"[^>]*>\n)/, `$1${bootstrap}`);
      const html = await vite.transformIndexHtml(req.url, source);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    }
  });
  vite = await createViteServer({
    configFile: false,
    root,
    appType: "custom",
    logLevel: "warn",
    server: { middlewareMode: true, hmr: { server } },
  });
  const close = server.close.bind(server);
  server.close = (cb) => { vite.close().finally(() => { server.closeAllConnections(); close(cb); }); return server; };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  (await createDevServer()).listen(PORT, "127.0.0.1", () => {
    console.log(`Supply Checkout (mock runtime): http://localhost:${PORT}/`);
    console.log("Options: ?seed=empty  ?viewer  ?nouser  ?mock={\"sampleError\":\"rate_limited\"}");
  });
}
