// Receipt steps (J5). See tests/ui/app.js.
import { expect } from "@playwright/test";

/** Uploads a receipt photo and waits for its review. */
export async function uploadReceipt(page, file) {
  await page.setInputFiles("#receiptFile", file);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
}

/** Opens the saved, unfinished receipt review. */
export const continueReview = (page) => page.getByRole("button", { name: "Continue review" }).click();

/** Adds a blank line to the receipt review. */
export const addReceiptLine = (page) => page.getByRole("button", { name: "+ Add item" }).click();
