import { App } from "aws-cdk-lib";
import { configFromContext } from "../lib/config.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

const app = new App();
addSupplyCheckout(app, configFromContext(app.node));
app.synth();
