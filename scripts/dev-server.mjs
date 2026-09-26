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
// Data lives in memory in the page: a reload starts over. index.html is read
// on every request, so edits show on reload.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { buildPage } from "./page.mjs";
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

// Exported so tests can run it on a free port
export const createDevServer = () => createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname !== "/") { res.writeHead(404).end(); return; }
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(buildPage({ head: bootstrap }));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDevServer().listen(PORT, "127.0.0.1", () => {
    console.log(`Supply Checkout (mock runtime): http://localhost:${PORT}/`);
    console.log("Options: ?seed=empty  ?viewer  ?nouser  ?mock={\"sampleError\":\"rate_limited\"}");
  });
}
