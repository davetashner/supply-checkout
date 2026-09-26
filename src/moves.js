// Checking items out to a sheet and returning them, as the app's document writes: the
// sheet line first, then the storage count (a read-then-write in src/main.js's bumpStock).
// Every checkout and return goes through here, so the AWS build can switch to the atomic,
// idempotent commands that update both in one request and can't count a retry twice.
// TODO(supply-checkout-1dg.1): use those commands in the web build once the API has them.
export const checkOut = (db, sheetId, key, item) => db.doc("sheets/" + sheetId).update({ items: { [key]: item } });
export const recordReturn = (db, sheetId, key, returned) => db.doc("sheets/" + sheetId).update({ items: { [key]: { returned } } });
export const setStock = (db, key, stock) => db.doc("products/" + key).update({ stock });
