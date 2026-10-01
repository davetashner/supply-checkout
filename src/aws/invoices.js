// The team's invoices, for its owners in the web build (supply-checkout-eja): the latest
// ones as Stripe has them (GET /teams/{teamId}/billing/invoices), each with its date,
// number, amount and whether it's paid, and links to Stripe's own page for it and its PDF.
// Stripe emails invoices and receipts itself, and prints the billing name, address and tax
// ID on them; owners change those, and see older invoices, in Billing (the Customer Portal).
// The route needs two-step sign-in like the rest of billing: refused for want of it, the
// screen closes and `needsTwoStep` opens the setup, or asks to sign in again when the
// session began before it was turned on (`mfa_sign_in_again`).
import { esc } from "../format.js";
import { openModal, closeModal } from "../dom.js";

const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const amount = (cents, currency) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
// Stripe's statuses, in words; an open invoice says what's still due
const STATUS = {
  paid: () => "Paid",
  open: (i) => `Due: ${amount(i.amountDue, i.currency)}`,
  void: () => "Void",
  uncollectible: () => "Not paid",
};

// A link to Stripe, opened in a new tab so the app stays where it was
const link = (url, text, label) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)}">${text}</a>` : "";

function invoiceHTML(i) {
  const name = i.number ? `Invoice ${i.number}` : "Invoice";
  const status = (STATUS[i.status] || (() => i.status))(i);
  return `<li class="invoice" data-invoice="${esc(i.id)}">
    <span class="invoice-what">${esc(day(i.createdAt))} <span class="muted">${esc(name)}</span></span>
    <span class="invoice-amount">${esc(amount(i.total, i.currency))} <span class="muted">${esc(status)}</span></span>
    <span class="invoice-links">${link(i.hostedUrl, "View", `View ${name}`)} ${link(i.pdfUrl, "PDF", `${name} as a PDF`)}</span>
  </li>`;
}

export function openInvoices(api, team, needsTwoStep) {
  openModal(`<h2>Invoices</h2>
    <p class="hint">Stripe emails each invoice and receipt to your billing email. To change the name, address or tax ID on them, or to see older invoices, use Billing.</p>
    <p class="error" role="alert" id="invoicesFail" hidden></p>
    <div id="invoiceList" aria-live="polite"><p class="muted" role="status">Loading invoices…</p></div>
    <div class="modal-actions"><button type="button" class="btn" id="invoicesClose">Close</button></div>`, (m) => {
    const list = m.querySelector("#invoiceList"), fail = m.querySelector("#invoicesFail");
    m.querySelector("#invoicesClose").addEventListener("click", closeModal);

    async function load() {
      fail.hidden = true;
      list.innerHTML = `<p class="muted" role="status">Loading invoices…</p>`;
      try {
        const page = await api("GET", `/teams/${encodeURIComponent(team.id)}/billing/invoices`);
        list.innerHTML = (page.invoices.length ? `<ul class="invoices">${page.invoices.map(invoiceHTML).join("")}</ul>` : `<p class="muted">No invoices yet.</p>`)
          + (page.hasMore ? `<p class="hint" id="olderInvoices">Older invoices are in Billing.</p>` : "");
      } catch (e) {
        if (e.reason === "mfa_required" || e.reason === "mfa_sign_in_again") {
          closeModal();
          needsTwoStep(e);
          return;
        }
        fail.textContent = e.reason === "no_billing_account" ? "This team has no billing account yet, so it has no invoices." : "Couldn't load invoices. Check your connection and try again.";
        fail.hidden = false;
        list.innerHTML = e.reason === "no_billing_account" ? "" : `<button type="button" class="btn" id="invoicesRetry">Try again</button>`;
        const retry = list.querySelector("#invoicesRetry");
        if (retry) retry.addEventListener("click", load);
      }
    }
    load();
  });
}
