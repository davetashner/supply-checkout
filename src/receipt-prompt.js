import { WEB } from "./build.js";

export const RECEIPT_PROMPT = `The image is a photo of a store receipt for supplies. Extract the purchased line items.
Reply with only JSON in this shape:
{"store": "Home Depot", "date": "2026-09-24", "items": [{"raw": "GLAD KTCH 13G 45CT", "name": "Glad kitchen trash bags, 13 gal, 45 ct", "qty": 2, "price": 11.97, "match": "i3"}], "subtotal": 23.94, "tax": 1.68, "total": 25.62}
Rules:
- "price" is the price of ONE unit after any discount or coupon printed for that item. If a line shows a quantity and a line total, divide.
- Expand abbreviated receipt text into a plain, readable product name. Keep brand, size and count details.
- Leave out subtotal, tax, total, payment, change, rewards, and bag or deposit fee lines.
- If the same item appears on several lines, list it once with the combined quantity.
- Use null for store, date, subtotal, tax or total when you can't read them. Date must be YYYY-MM-DD.
- "raw" is the item text exactly as printed on the receipt.
- "match": the id of the inventory item below that is the same product, even if it's described differently. Use null if none is clearly the same. Don't match items that differ in size, count, color or type.
- If the image is not a readable receipt, reply {"items": []}.`;

// `message`: the server's own words, used for `receipt_rate` (the web build's per-user rate
// limit, src/aws/receipts.js), which says how long to wait
export const sampleErr = (code, message) => WEB && code === "receipt_rate" ? message : ({
  not_granted: "Receipt reading needs permission to use Claude. Reload the page and allow it to try again.",
  sampling_disabled: "Receipt reading isn't available for this account.",
  rate_limited: "Too many requests right now. Wait a minute and try again.",
  image_rejected: "That image couldn't be used. Try a JPEG or PNG photo.",
  images_unavailable: "Receipt reading isn't available in this view.",
  invalid_json: "The receipt couldn't be read cleanly. Try again, or take a sharper photo.",
  session_expired: "Your sign-in expired. Reload the page and sign in again.",
  receipt_limit: "Your team has read all the receipts included this month. Enter the items by hand, or ask an owner about your plan.",
  trial_receipt_limit: "Your team has used all the receipt scans included in its free trial. Enter the items by hand, or ask an owner to subscribe to keep scanning receipts.",
  timeout: "Reading the receipt took too long. Try again, or take a sharper photo.",
}[code] || "Reading the receipt failed. Check your connection and try again.");
