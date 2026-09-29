// Lambda entry point for the operator group watch (see operator-group-watch-handler.ts).

import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { cognitoRequest } from "../identity/cognito-admin.js";
import { OPERATORS_GROUP } from "../identity/names.js";
import { createObservability, withObservability } from "../observability/index.js";
import { createOperatorGroupWatchHandler } from "./operator-group-watch-handler.js";
import { listGroupMembers } from "./operator-group-members.js";
import { OPS_ENV } from "./names.js";

const obs = createObservability({ service: "ops" });
const userPoolId = process.env[OPS_ENV.opsUserPoolId] ?? "";
const parameter = process.env[OPS_ENV.groupSnapshotParameter] ?? "";
const ssm = new SSMClient({ region: obs.region });
const cognito = cognitoRequest({ region: obs.region, timeoutMs: 5_000 });

export const handler = withObservability(
  obs,
  createOperatorGroupWatchHandler({
    obs,
    listMembers: () => listGroupMembers(cognito, userPoolId, OPERATORS_GROUP),
    readSnapshot: async () => (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value ?? "",
    writeSnapshot: async (snapshot) => {
      await ssm.send(new PutParameterCommand({ Name: parameter, Value: snapshot, Type: "String", Overwrite: true }));
    },
  }),
);
