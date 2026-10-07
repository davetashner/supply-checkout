// Shared seed data for suites that start from a realistic, already-used state.
export const usedState = {
  seed: {
    "products/SKU1": { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, stock: 10 },
    "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, stock: 2 },
    "projects/s1": {
      client: "Echo Studio",
      date: "2026-09-24",
      createdBy: "u_test",
      createdAt: "2026-09-24T12:00:00Z",
      status: "open",
      items: {
        SKU1: { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, out: 3, returned: 1 },
        "nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, out: 2, returned: 0 },
      },
    },
  },
  receipt: {
    store: "Hardware Co",
    date: "2026-09-20",
    items: [
      { raw: "STRG BIN 12QT", name: "Sterilite 12 qt storage bin", qty: 4, price: 5.5, match: "i1" },
      { raw: "PTR TAPE 1.88", name: "Painter's tape, 1.88 in", qty: 2, price: 6.25, match: null },
    ],
    subtotal: 34.5,
    tax: 2.4,
    total: 36.9,
  },
};

export const fakeImage = { name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake image") };
