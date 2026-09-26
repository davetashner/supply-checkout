// Demo sheets, inventory and a canned receipt, for `npm run dev` and the demo
// build (npm run build:demo). Dates are relative to today, so the demo always
// looks current. Plain data: it runs in Node (the dev server) and the browser.
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export function demoState() {
  return {
    seed: {
      "products/012345678905": { code: "012345678905", name: "Nitrile gloves, box of 100", price: 12.5, cost: 9.75, packSize: 10, stock: 8 },
      "products/SKU-TOWEL": { code: "SKU-TOWEL", name: "Paper towels, 6 roll", price: 8.5, cost: 6.4, stock: 14 },
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
}
