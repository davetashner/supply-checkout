// Inventory steps (J2). See tests/ui/app.js.
import { modal } from "./app.js";

/** Opens the Add item form on the Inventory tab. */
export const startAddItem = (page) => page.getByRole("button", { name: "+ Add item", exact: true }).click();

// The item form's fields, by the name addItem takes them under
const FIELDS = {
  barcode: (form) => form.getByPlaceholder("Type, scan, or leave blank"),
  name: (form) => form.getByLabel("Item name", { exact: true }),
  stock: (form) => form.getByLabel("Single items in storage now", { exact: true }),
  reorderAt: (form) => form.getByLabel("Reorder at (optional)", { exact: true }),
  usualOrder: (form) => form.getByLabel("Usual order (optional)", { exact: true }),
};

/** Fills the open item form's `fields` (see FIELDS), in the order given. */
export async function fillItem(page, fields) {
  for (const [field, value] of Object.entries(fields)) await FIELDS[field](modal(page)).fill(value);
}

/** The item form's Save button. */
export const saveItem = (page) => modal(page).getByRole("button", { name: "Save", exact: true }).click();

/** Adds an item from the Inventory tab: opens the form, fills `fields` and saves. */
export async function addItem(page, fields) {
  await startAddItem(page);
  await fillItem(page, fields);
  await saveItem(page);
}

/** The inventory row for `name`. */
export const inventoryRow = (page, name) => page.locator("#main tbody tr", { hasText: name });
