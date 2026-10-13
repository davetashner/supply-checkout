// Why reading a receipt failed (src/receipt-prompt.js sampleErr). The prompt sent to the model stays English.
export default {
  "receiptPrompt.not_granted": "Receipt reading needs permission to use Claude. Reload the page and allow it to try again.",
  "receiptPrompt.sampling_disabled": "Receipt reading isn't available for this account.",
  "receiptPrompt.rate_limited": "Too many requests right now. Wait a minute and try again.",
  "receiptPrompt.image_rejected": "That image couldn't be used. Try a JPEG or PNG photo.",
  "receiptPrompt.images_unavailable": "Receipt reading isn't available in this view.",
  "receiptPrompt.invalid_json": "The receipt couldn't be read cleanly. Try again, or take a sharper photo.",
  "receiptPrompt.session_expired": "Your sign-in expired. Reload the page and sign in again.",
  "receiptPrompt.receipt_limit": "Your team has read all the receipts included this month. Enter the items by hand, or ask an owner about your plan.",
  "receiptPrompt.trial_receipt_limit": "Your team has used all the receipt scans included in its free trial. Enter the items by hand, or ask an owner to subscribe to keep scanning receipts.",
  "receiptPrompt.timeout": "Reading the receipt took too long. Try again, or take a sharper photo.",
  "receiptPrompt.failed": "Reading the receipt failed. Check your connection and try again.",
};
