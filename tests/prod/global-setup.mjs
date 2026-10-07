// Global setup for the prod journey suite: the guards and records in
// scripts/journeys/lib/setup.mjs, with the real Cognito, API and mail bucket.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appConfig, createApi } from "../../scripts/journeys/lib/api.mjs";
import { createCognito } from "../../scripts/journeys/lib/cognito.mjs";
import { PROD, readConfig, runDir, runId } from "../../scripts/journeys/lib/config.mjs";
import { createMasker } from "../../scripts/journeys/lib/mask.mjs";
import { createS3 } from "../../scripts/journeys/lib/s3.mjs";
import { setup } from "../../scripts/journeys/lib/setup.mjs";
import { freshTotp } from "../../scripts/journeys/lib/totp.mjs";

export default async function globalSetup(config) {
  const env = process.env;
  const id = runId(env);
  const dir = runDir(env, id);
  const masker = createMasker();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const result = await setup({
      env,
      baseUrls: config.projects.map((p) => p.use.baseURL),
      runId: id,
      appConfig,
      createCognito: (clientId) => createCognito({ region: PROD.region, clientId }),
      apiFor: (token) => createApi({ token }),
      // Read lazily: setup checks the configuration (and refuses) before anything uses the bucket
      mailS3: createS3(readConfigSafe(env)?.buckets.mail ?? ""),
      masker,
      totpCode: () => freshTotp(env.JOURNEYS_OWNER_TOTP, { stateFile: path.join(dir, "totp-step") }),
    });
    Object.assign(process.env, result.env);
    writeFileSync(path.join(dir, "warnings.json"), JSON.stringify(result.warnings), { mode: 0o600 });
    for (const w of result.warnings) console.log(masker.redact(`journeys: warning: ${w}`));
  } catch (err) {
    // Only the message, masked: never a stack or a cause with values in it
    // eslint-disable-next-line preserve-caught-error -- the cause could hold unmasked values
    throw new Error(masker.redact(err instanceof Error ? err.message : String(err)));
  }
}

function readConfigSafe(env) {
  try { return readConfig(env); } catch { return null; }
}
