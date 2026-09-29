// GitHub Actions' OIDC provider and deploy role (docs/infrastructure.md,
// "GitHub Actions deploy role"). A separate CDK app from bin/app.ts, so a
// pipeline running `cdk deploy --all` never deploys it and can't change its
// own trust. The owner deploys it once, with the workload account's profile:
//
//   npm run deploy:github-deploy -- --profile supply-prod
import { App } from "aws-cdk-lib";
import { configFromContext, githubRepositoryFromContext } from "../lib/config.js";
import { addGithubDeploy } from "../lib/supply-checkout.js";

const app = new App();
addGithubDeploy(app, configFromContext(app.node), githubRepositoryFromContext(app.node));
app.synth();
