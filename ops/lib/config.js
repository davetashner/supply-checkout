// Where the operator page signs in and what it calls (supply-checkout-gxlt).
//
// scripts/publish-web.mjs writes ops-config.json into an ops release from the identity and api
// stacks' SSM outputs, checking the hosts there too. The page checks them again against its own
// host: served at ops.<env domain>, it only ever signs in at ops-auth.<env domain> and sends the
// operator's token only to api.<env domain>. The CloudFront CSP (connect-src) enforces the same.

export const CONFIG_PATH = "/ops-config.json";
const CLIENT_ID = /^[A-Za-z0-9]{1,128}$/;
const OPS_HOST = /^ops\.([a-z0-9-]+(\.[a-z0-9-]+)+)$/;

export class ConfigError extends Error {}

/** The environment's domain from the page's own host name (ops.<domain>). */
export function envDomainOf(hostname) {
  const match = OPS_HOST.exec(String(hostname));
  if (!match) throw new ConfigError("The operator page is served only from ops.<domain>");
  return match[1];
}

/** The page's config, checked against where it's served from. Throws ConfigError. */
export function checkConfig(raw, location) {
  if (location.protocol !== "https:") throw new ConfigError("The operator page needs https");
  const domain = envDomainOf(location.hostname);
  const config = raw && typeof raw === "object" ? raw : {};
  const expected = { apiUrl: `https://api.${domain}`, authUrl: `https://ops-auth.${domain}` };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) throw new ConfigError(`ops-config.json ${key} must be ${value}`);
  }
  if (typeof config.clientId !== "string" || !CLIENT_ID.test(config.clientId)) throw new ConfigError("ops-config.json has no ops client ID");
  return {
    apiUrl: expected.apiUrl,
    authUrl: expected.authUrl,
    clientId: config.clientId,
    // Cognito matches callback URLs exactly: the page's root, as the ops client lists it
    redirectUri: `https://${location.hostname}/`,
    domain,
  };
}

/** Loads and checks ops-config.json. Never cached. */
export async function loadConfig(fetchFn, location) {
  const response = await fetchFn(CONFIG_PATH, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new ConfigError(`Couldn't load the page's config (${response.status})`);
  const raw = await response.json().catch(() => null);
  return checkConfig(raw, location);
}
