// The prod journey tests' AWS pieces (docs/infrastructure.md, "Journey tests";
// supply-checkout-o60.3): the test mail subdomain and its SES receipt rule, the
// mail and results buckets, and the role the journeys job assumes. A separate
// CDK app from bin/app.ts, so the release pipeline never deploys it: the role
// must not exist before the production-journeys environment is set up on
// GitHub. The owner deploys it with the workload account's profile, through the
// wrapper that refuses unless that environment is locked down
// (scripts/deploy-journeys.mjs):
//
//   npm run deploy:journeys -- --profile supply-prod
import { App } from "aws-cdk-lib";
import { configFromContext, githubRepositoryFromContext } from "../lib/config.js";
import { addJourneys } from "../lib/supply-checkout.js";

const app = new App();
addJourneys(app, configFromContext(app.node), githubRepositoryFromContext(app.node));
app.synth();
