// The backup account's side of the backups (docs/backups.md): one vault per
// environment for the daily copies from the workload accounts. A separate CDK
// app from bin/app.ts, so `cdk deploy --all` with a workload account's profile
// can never create it there. Deploy it with the backup account's profile:
//
//   npm run deploy:backup-account -- --profile <backup account profile> \
//     --parameters SourceAccountIds=<prod account ID>
import { App } from "aws-cdk-lib";
import { configFromContext } from "../lib/config.js";
import { addBackupAccount } from "../lib/supply-checkout.js";

const app = new App();
addBackupAccount(app, configFromContext(app.node));
app.synth();
