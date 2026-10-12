// Billing records (supply-checkout-ijt7): the invoices a purged team's record keeps, the checks on it,
// and the S3 write (once, with If-None-Match). The purge's use of it is in account-deletion-api.test.ts.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { BILLING_RECORD_PREFIX, BILLING_RECORD_RETENTION_DAYS, BILLING_RECORDS_ENV, billingRecordsBucketName } from "../src/billing-records/names.js";
import { type BillingRecord, billingRecordKey, billingRecordLogFromEnv, exportInvoices, invoiceRecord, keepBillingRecord, MAX_INVOICES, type StripeInvoice, s3BillingRecordLog, validBillingRecord } from "../src/billing-records/records.js";
import { REGION } from "./helpers.js";

const invoice = (n: number, fields: Partial<StripeInvoice> = {}): StripeInvoice => ({
  id: `in_${n}`,
  number: `INV-${n}`,
  created: 1_790_000_000,
  status: "paid",
  currency: "usd",
  subtotal: 1000,
  total: 1060,
  amount_paid: 1060,
  period_start: 1_790_000_000,
  period_end: 1_792_592_000,
  total_taxes: [{ amount: 40 }, { amount: 20 }],
  status_transitions: { paid_at: 1_790_000_050 },
  customer_address: { country: "US", state: "VA" },
  ...fields,
});

const record = (fields: Partial<BillingRecord> = {}): BillingRecord => ({ teamId: "team-a", stripeCustomerId: "cus_123", recordedAt: "2026-11-12T00:00:00.000Z", invoices: [invoiceRecord(invoice(1))], ...fields });

describe("names", () => {
  it("keeps records 7 years, never fewer than 7 calendar years", () => {
    expect(BILLING_RECORD_RETENTION_DAYS).toBeGreaterThanOrEqual(7 * 365 + 2);
    expect(billingRecordsBucketName("prod", REGION, "123456789012")).toBe(`supply-checkout-prod-billing-records-${REGION}-123456789012`);
    expect(billingRecordKey("team-a")).toBe(`${BILLING_RECORD_PREFIX}team-a.json`);
    for (const bad of ["", "team a", "../team", "team/a", "a".repeat(129)]) expect(() => billingRecordKey(bad)).toThrow("Invalid team ID");
  });
});

describe("invoiceRecord", () => {
  it("keeps amounts, dates and the tax place, summing the tax lines or using the older tax field, and nothing else of the invoice", () => {
    const r = invoiceRecord({ ...invoice(1), customer_email: "a@example.com", customer_name: "A B", hosted_invoice_url: "https://x.test" } as StripeInvoice);
    expect(r).toEqual({
      id: "in_1",
      number: "INV-1",
      created: "2026-09-21T14:13:20.000Z",
      status: "paid",
      currency: "usd",
      subtotal: 1000,
      tax: 60,
      total: 1060,
      amountPaid: 1060,
      paidAt: "2026-09-21T14:14:10.000Z",
      periodStart: "2026-09-21T14:13:20.000Z",
      periodEnd: "2026-10-21T14:13:20.000Z",
      country: "US",
      state: "VA",
    });
    expect(invoiceRecord(invoice(2, { total_taxes: undefined, tax: 7 })).tax).toBe(7);
    expect(invoiceRecord(invoice(3, { total_taxes: null, tax: null })).tax).toBe(0);
    const open = invoiceRecord(invoice(4, { number: null, status: null, status_transitions: null, customer_address: null }));
    expect(open).toMatchObject({ number: null, status: null, paidAt: null, country: null, state: null });
    expect(invoiceRecord(invoice(5, { status_transitions: { paid_at: null }, customer_address: { country: "CA" } }))).toMatchObject({ paidAt: null, country: "CA", state: null });
  });
});

describe("exportInvoices", () => {
  const lister = (all: StripeInvoice[], calls: { after?: string }[] = []) => ({
    invoices: {
      async list(params: { customer: string; limit: number; starting_after?: string }) {
        calls.push({ ...(params.starting_after ? { after: params.starting_after } : {}) });
        const from = params.starting_after ? all.findIndex((i) => i.id === params.starting_after) + 1 : 0;
        return { data: all.slice(from, from + params.limit), has_more: from + params.limit < all.length };
      },
    },
  });

  it("pages through every invoice, and an empty list is an empty export", async () => {
    const calls: { after?: string }[] = [];
    const all = Array.from({ length: 250 }, (_, i) => invoice(i));
    expect((await exportInvoices(lister(all, calls), "cus_123")).map((i) => i.id)).toEqual(all.map((i) => i.id));
    expect(calls).toEqual([{}, { after: "in_99" }, { after: "in_199" }]);
    expect(await exportInvoices(lister([]), "cus_123")).toEqual([]);
  });

  it("refuses a customer ID that isn't one, more invoices than a record holds, and a page that says more but has none", async () => {
    await expect(exportInvoices(lister([]), "acct_1")).rejects.toThrow("Invalid Stripe customer ID");
    await expect(exportInvoices(lister([]), "cus_1 2")).rejects.toThrow("Invalid Stripe customer ID");
    const many = Array.from({ length: MAX_INVOICES + 1 }, (_, i) => invoice(i));
    await expect(exportInvoices(lister(many), "cus_123")).rejects.toThrow("Too many invoices");
    await expect(exportInvoices({ invoices: { list: async () => ({ data: [], has_more: true }) } }, "cus_123")).rejects.toThrow("sent none");
  });
});

describe("validBillingRecord", () => {
  it("passes a record through with only its own fields", () => {
    const extra = { ...record(), password: "x", invoices: [{ ...invoiceRecord(invoice(1)), email: "a@example.com" }] };
    expect(validBillingRecord(extra)).toEqual(record());
    expect(JSON.stringify(validBillingRecord(extra))).not.toMatch(/password|a@example\.com/);
    // An invoice not paid (so no paidAt) is a record too
    const unpaid = record({ invoices: [invoiceRecord(invoice(2, { status: "open", status_transitions: { paid_at: null } }))] });
    expect(validBillingRecord(unpaid).invoices[0]?.paidAt).toBeNull();
  });

  it("refuses anything else", () => {
    const good = invoiceRecord(invoice(1));
    for (const bad of [null, "x", 1, record({ teamId: "team a" }), record({ stripeCustomerId: "acct_1" }), record({ recordedAt: "soon" }), { ...record(), invoices: "none" }, record({ invoices: [{ ...good, id: "cus_1" }] }), record({ invoices: [{ ...good, total: 10.5 }] }), record({ invoices: [{ ...good, tax: Number.NaN }] }), record({ invoices: [{ ...good, created: "yesterday" }] }), record({ invoices: [{ ...good, paidAt: "soon" }] }), { ...record(), invoices: new Array(MAX_INVOICES + 1).fill(good) }]) {
      expect(() => validBillingRecord(bad)).toThrow();
    }
  });
});

describe("the S3 log", () => {
  const sent: PutObjectCommand[] = [];
  const s3 = (fail?: { name: string }) => ({
    async send(command: PutObjectCommand) {
      sent.push(command);
      if (fail) throw Object.assign(new Error("S3"), fail);
    },
  });

  it("writes one JSON object per team, only if none is there, and keeps the first when one is", async () => {
    sent.length = 0;
    await s3BillingRecordLog({ bucket: "b", s3: s3() }).record(record());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({ Bucket: "b", Key: "teams/team-a.json", ContentType: "application/json", IfNoneMatch: "*" });
    expect(JSON.parse(String(sent[0]?.input.Body))).toEqual(record());
    // Already there: the first stays, and it isn't an error
    await expect(s3BillingRecordLog({ bucket: "b", s3: s3({ name: "PreconditionFailed" }) }).record(record())).resolves.toBeUndefined();
    // Anything else is
    await expect(s3BillingRecordLog({ bucket: "b", s3: s3({ name: "AccessDenied" }) }).record(record())).rejects.toThrow("S3");
    // Nothing invalid is sent
    sent.length = 0;
    await expect(s3BillingRecordLog({ bucket: "b", s3: s3() }).record(record({ teamId: "../x" }))).rejects.toThrow("Invalid team ID");
    expect(sent).toEqual([]);
  });

  it("fails closed without its bucket or region", () => {
    expect(() => billingRecordLogFromEnv({})).toThrow("BILLING_RECORDS_BUCKET and BILLING_RECORDS_REGION must be set");
    expect(() => billingRecordLogFromEnv({ [BILLING_RECORDS_ENV.bucket]: "b" })).toThrow("must be set");
    expect(billingRecordLogFromEnv({ [BILLING_RECORDS_ENV.bucket]: "b", [BILLING_RECORDS_ENV.region]: REGION })).toHaveProperty("record");
  });
});

describe("keepBillingRecord", () => {
  const now = () => new Date("2026-11-12T00:00:00.000Z");

  it("writes the record only after the invoices are listed, and says there was nothing to keep for a customer Stripe doesn't have", async () => {
    const written: BillingRecord[] = [];
    const log = { async record(r: BillingRecord) { written.push(r); } };
    const stripe = { invoices: { list: async () => ({ data: [invoice(1)], has_more: false }) } };
    expect(await keepBillingRecord({ stripe, log, now }, "team-a", "cus_123")).toBe("kept");
    expect(written).toEqual([record()]);
    written.length = 0;
    const missing = { invoices: { list: async () => { throw Object.assign(new Error("No such customer"), { code: "resource_missing" }); } } };
    expect(await keepBillingRecord({ stripe: missing, log, now }, "team-a", "cus_123")).toBe("no_customer");
    expect(written).toEqual([]);
    // Any other Stripe error, or a write that fails, is the caller's to handle: the customer stays
    const down = { invoices: { list: async () => { throw Object.assign(new Error("down"), { name: "StripeConnectionError" }); } } };
    await expect(keepBillingRecord({ stripe: down, log, now }, "team-a", "cus_123")).rejects.toThrow("down");
    const failing = { async record() { throw new Error("S3 down"); } };
    await expect(keepBillingRecord({ stripe, log: failing, now }, "team-a", "cus_123")).rejects.toThrow("S3 down");
  });
});
