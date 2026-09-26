// Runs the app locally against the same in-memory runtime the tests use, so
// it can be tried in a browser without publishing to claude.ai.
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
import { installMockClaude } from "../tests/mock-claude.js";

const PORT = Number(process.env.PORT) || 5173;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const demo = {
  seed: {
    "products/012345678905": { code: "012345678905", name: "Nitrile gloves, box of 100", price: 12.5, stock: 8 },
    "products/SKU-TOWEL": { code: "SKU-TOWEL", name: "Paper towels, 6 roll", price: 8.5, stock: 14 },
    "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, stock: 4 },
    "products/nb-cloth": { code: "", name: "Microfiber cloths, 24 pack", price: 18 },
    "sheets/demo-open": {
      client: "Acme Offices", date: day(0), createdBy: "u_test", createdAt: new Date().toISOString(), status: "open",
      items: {
        "012345678905": { code: "012345678905", name: "Nitrile gloves, box of 100", price: 12.5, out: 2, returned: 0 },
        "SKU-TOWEL": { code: "SKU-TOWEL", name: "Paper towels, 6 roll", price: 8.5, out: 3, returned: 1 },
      },
    },
    "sheets/demo-closed": {
      client: "Harbor Dental", date: day(3), createdBy: "u_test", createdAt: new Date().toISOString(), status: "closed",
      items: { "nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, out: 4, returned: 1 } },
    },
  },
  receipt: {
    store: "Hardware Co", date: day(1),
    items: [
      { raw: "NITRL GLV 100CT", name: "Nitrile gloves, box of 100", qty: 2, price: 12.97, match: "i1" },
      { raw: "PTR TAPE 1.88", name: "Painter's tape, 1.88 in", qty: 3, price: 6.25, match: null },
      { raw: "MICROFBR 24PK", name: "Microfiber cloths, 24 pack", qty: 1, price: 18, match: "i4" },
    ],
    subtotal: 62.69, tax: 4.39, total: 67.08,
  },
};

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
