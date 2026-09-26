// The demo build's entry (npm run build:demo). It runs before the app's own
// script and stands in for the runtime with the same in-memory mock the tests and
// `npm run dev` use, seeded with the demo data. Nothing leaves the page: no
// accounts, no backend, and a reload starts over. The banner markup is added to
// the page by vite.config.js.
import "./demo.css";
import { demoState } from "./data.js";
import { installMockClaude } from "../tests/mock-claude.js";

installMockClaude({
  ...demoState(),
  userName: "Demo user",
  // A plain circle, so the demo user's avatar isn't a broken image
  avatarUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="#0E6B58"/></svg>'),
  // Receipt reading returns the canned receipt, after a pause like a real read
  sampleDelay: 1200,
});

// The mock only records downloads; the demo saves the CSV for real.
const use = window.claude.use;
window.claude.use = async (name) => (name === "downloads" ? { save: saveFile } : use(name));

async function saveFile({ filename, data }) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { status: "saved" };
}

// The app keeps an unsaved receipt review in localStorage (supplyCheckout.receiptDraft
// in src/main.js) to offer it again later. In the demo, a reload starts over.
try { localStorage.removeItem("supplyCheckout.receiptDraft"); } catch {}
