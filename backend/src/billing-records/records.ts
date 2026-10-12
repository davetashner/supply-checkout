// Billing records (supply-checkout-ijt7): before the team purge deletes a team's
// Stripe customer, it writes the customer's invoices to a bucket under
// compliance-mode Object Lock for 7 years (BILLING_RECORD_RETENTION_DAYS). The
// privacy policy promises we keep our own tax and accounting records for 7 years;
// Stripe holds the invoices, and deleting the customer deletes them there.
//
// What a record holds: the team and customer IDs, when it was written, and for each
// invoice its Stripe ID, number, dates, status, currency, subtotal, tax, total and
// amount paid, and the billing country and state (where the tax was due). No card
// data, no name, no email, no street address. Locked records can't be erased, which
// the policy says: the law lets us keep tax records past an erasure request.
//
// Written once: a retry finds the record there (If-None-Match) and keeps the first.
// The caller (ops/team-purge-handler.ts) deletes the customer only after the record
// is written, and leaves the deletion queued when it can't be.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BILLING_RECORD_PREFIX, BILLING_RECORDS_ENV } from "./names.js";

/** The most invoices one record holds. A team has a few a month; more means something is wrong, so the export fails. */
export const MAX_INVOICES = 5000;
const PAGE_SIZE = 100;

export interface InvoiceRecord {
  readonly id: string;
  readonly number: string | null;
  /** When Stripe created it (ISO 8601). */
  readonly created: string;
  readonly status: string | null;
  readonly currency: string;
  /** Amounts in the currency's smallest unit (cents). */
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
  readonly amountPaid: number;
  /** When it was paid (ISO 8601), if it was. */
  readonly paidAt: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Where the tax was due: the billing address's country and state, never the street. */
  readonly country: string | null;
  readonly state: string | null;
}

export interface BillingRecord {
  readonly teamId: string;
  readonly stripeCustomerId: string;
  /** When the record was written (ISO 8601). */
  readonly recordedAt: string;
  readonly invoices: readonly InvoiceRecord[];
}

/** The invoice fields this reads from Stripe's invoice object; the SDK's Invoice has all of them. */
export interface StripeInvoice {
  id: string;
  number: string | null;
  created: number;
  status: string | null;
  currency: string;
  subtotal: number;
  total: number;
  amount_paid: number;
  period_start: number;
  period_end: number;
  total_taxes?: { amount: number }[] | null;
  tax?: number | null;
  status_transitions?: { paid_at: number | null } | null;
  customer_address?: { country?: string | null; state?: string | null } | null;
}

/** The one Stripe call the export makes. */
export interface InvoiceLister {
  readonly invoices: {
    list(params: { customer: string; limit: number; starting_after?: string }): PromiseLike<{ data: StripeInvoice[]; has_more: boolean }>;
  };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CUSTOMER = /^cus_[A-Za-z0-9]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The object key for a team's record: `teams/<teamId>.json`. */
export function billingRecordKey(teamId: string): string {
  if (typeof teamId !== "string" || !ID.test(teamId)) throw new Error("Invalid team ID in a billing record");
  return `${BILLING_RECORD_PREFIX}${teamId}.json`;
}

/** One Stripe invoice as a record: the fields above and nothing else of it. */
export function invoiceRecord(invoice: StripeInvoice): InvoiceRecord {
  // The tax in whichever field this API version has: the sum of its tax lines, or the older single total
  const tax = Array.isArray(invoice.total_taxes) ? invoice.total_taxes.reduce((sum, t) => sum + t.amount, 0) : (invoice.tax ?? 0);
  const paidAt = invoice.status_transitions?.paid_at;
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    created: iso(invoice.created),
    status: invoice.status ?? null,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    tax,
    total: invoice.total,
    amountPaid: invoice.amount_paid,
    paidAt: typeof paidAt === "number" ? iso(paidAt) : null,
    periodStart: iso(invoice.period_start),
    periodEnd: iso(invoice.period_end),
    country: invoice.customer_address?.country ?? null,
    state: invoice.customer_address?.state ?? null,
  };
}

/**
 * Every invoice of a customer, oldest page last as Stripe lists them, as records. Throws if
 * there are more than MAX_INVOICES, or Stripe says there are more but sends no page.
 */
export async function exportInvoices(stripe: InvoiceLister, customerId: string): Promise<InvoiceRecord[]> {
  if (!CUSTOMER.test(customerId)) throw new Error("Invalid Stripe customer ID in a billing record");
  const invoices: InvoiceRecord[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({ customer: customerId, limit: PAGE_SIZE, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const invoice of page.data) invoices.push(invoiceRecord(invoice));
    if (invoices.length > MAX_INVOICES) throw new Error("Too many invoices for one billing record");
    if (!page.has_more) return invoices;
    const last = page.data.at(-1);
    if (!last) throw new Error("Stripe listed more invoices but sent none");
    startingAfter = last.id;
  }
}

/** The record, checked: IDs that are IDs, ISO times, whole-number amounts. Throws on anything else. */
export function validBillingRecord(value: unknown): BillingRecord {
  const r = value as Partial<BillingRecord> | null;
  if (!r || typeof r !== "object") throw new Error("Not a billing record");
  const key = billingRecordKey(r.teamId as string);
  if (typeof r.stripeCustomerId !== "string" || !CUSTOMER.test(r.stripeCustomerId)) throw new Error(`Invalid stripeCustomerId in ${key}`);
  if (typeof r.recordedAt !== "string" || !ISO.test(r.recordedAt)) throw new Error(`Invalid recordedAt in ${key}`);
  if (!Array.isArray(r.invoices) || r.invoices.length > MAX_INVOICES) throw new Error(`Invalid invoices in ${key}`);
  const invoices = r.invoices.map((i: InvoiceRecord) => {
    const amounts = [i.subtotal, i.tax, i.total, i.amountPaid];
    if (typeof i.id !== "string" || !/^in_[A-Za-z0-9_]{1,128}$/.test(i.id) || !amounts.every(Number.isSafeInteger)) throw new Error(`Invalid invoice in ${key}`);
    if (![i.created, i.periodStart, i.periodEnd, ...(i.paidAt === null ? [] : [i.paidAt])].every((t) => typeof t === "string" && ISO.test(t))) throw new Error(`Invalid invoice time in ${key}`);
    return { id: i.id, number: i.number, created: i.created, status: i.status, currency: i.currency, subtotal: i.subtotal, tax: i.tax, total: i.total, amountPaid: i.amountPaid, paidAt: i.paidAt, periodStart: i.periodStart, periodEnd: i.periodEnd, country: i.country, state: i.state };
  });
  return { teamId: r.teamId as string, stripeCustomerId: r.stripeCustomerId, recordedAt: r.recordedAt, invoices };
}

/** Writes billing records. */
export interface BillingRecordLog {
  record(record: BillingRecord): Promise<void>;
}

/** The S3 call this module makes; an S3Client, or a fake in tests. */
export interface S3Like {
  send(command: PutObjectCommand): Promise<unknown>;
}

const errorName = (error: unknown) => (error as { name?: string } | null)?.name;

/** A BillingRecordLog writing to the bucket, once per team. */
export function s3BillingRecordLog(options: { readonly bucket: string; readonly s3: S3Like }): BillingRecordLog {
  return {
    async record(input) {
      const record = validBillingRecord(input);
      try {
        await options.s3.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: billingRecordKey(record.teamId),
            Body: JSON.stringify(record),
            ContentType: "application/json",
            // Written once: a retry keeps the first record
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        if (errorName(error) !== "PreconditionFailed") throw error;
      }
    },
  };
}

/** The billing record log for a Lambda: BILLING_RECORDS_BUCKET, in BILLING_RECORDS_REGION. Fails closed when either isn't set. */
export function billingRecordLogFromEnv(env: NodeJS.ProcessEnv = process.env): BillingRecordLog {
  const bucket = env[BILLING_RECORDS_ENV.bucket];
  const region = env[BILLING_RECORDS_ENV.region];
  if (!bucket || !region) throw new Error(`${BILLING_RECORDS_ENV.bucket} and ${BILLING_RECORDS_ENV.region} must be set`);
  return s3BillingRecordLog({ bucket, s3: new S3Client({ region }) });
}

/**
 * Exports a customer's invoices and writes the team's record. Resolves only once S3 has the
 * record, so the caller may delete the customer. A customer Stripe doesn't have (resource_missing)
 * resolves "no_customer": nothing is left to keep.
 */
export async function keepBillingRecord(
  deps: { readonly stripe: InvoiceLister; readonly log: BillingRecordLog; readonly now: () => Date },
  teamId: string,
  customerId: string,
): Promise<"kept" | "no_customer"> {
  let invoices: InvoiceRecord[];
  try {
    invoices = await exportInvoices(deps.stripe, customerId);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "resource_missing") return "no_customer";
    throw error;
  }
  await deps.log.record({ teamId, stripeCustomerId: customerId, recordedAt: deps.now().toISOString(), invoices });
  return "kept";
}
