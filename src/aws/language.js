// The language follows the user across devices (supply-checkout-ae27): /me's user.preferences.language is
// the language they chose on any device, saved with PATCH /me/preferences. This device speaks it from the
// next page load, and a choice made on this device before the server knew of one is sent up once.
import { OFFERED, chooseDeviceLanguage, currentLanguage, savedLanguage } from "../i18n.js";

/**
 * Called as /me loads. The server's language wins when it differs from the one this page started in (the
 * device keeps it and the page loads again); with none on the server, the device's own choice goes up.
 * Nothing for an API without the preference, and nothing while the address names a language (a reviewer's
 * preview of one, not the user's choice). Resolves true when the page is loading again.
 */
export async function syncLanguage(api, prefs) {
  if (!prefs || prefs.language === undefined || new URLSearchParams(location.search).has("lang")) return false;
  if (prefs.language) {
    if (prefs.language === currentLanguage()) return false;
    await chooseDeviceLanguage(prefs.language);
    location.reload();
    return true;
  }
  const chosen = savedLanguage();
  if (OFFERED.includes(chosen)) api("PATCH", "/me/preferences", { language: chosen }).catch(() => {});
  return false;
}

/** Account's switch: saved for the user first, so another device speaks it too. Resolves false when it couldn't be saved. */
export async function saveLanguage(api, lang) {
  try { await api("PATCH", "/me/preferences", { language: lang }); } catch { return false; }
  await chooseDeviceLanguage(lang);
  return true;
}
