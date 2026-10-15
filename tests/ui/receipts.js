// Receipt steps (J5). See tests/ui/app.js.
import { expect } from "@playwright/test";

/** Uploads a receipt photo and waits for its review. */
export async function uploadReceipt(page, file) {
  await page.setInputFiles("#receiptFile", file);
  await expect(page.getByRole("heading", { name: "Review receipt", exact: true })).toBeVisible();
}

/**
 * The prompt sent to receipt reading (the mock's `sampleCalls`), once it has been sent. A test that reads it
 * straight after an upload can run before the call is made (seen in WebKit on CI), so wait for it.
 */
export async function receiptPrompt(page, index = 0) {
  await expect.poll(() => page.evaluate((i) => window.__mock.sampleCalls.length > i, index)).toBe(true);
  return page.evaluate((i) => window.__mock.sampleCalls[i], index);
}

/** Opens the saved, unfinished receipt review. */
export const continueReview = (page) => page.getByRole("button", { name: "Continue review", exact: true }).click();

/** Adds a blank line to the receipt review. */
export const addReceiptLine = (page) => page.getByRole("button", { name: "+ Add item", exact: true }).click();
