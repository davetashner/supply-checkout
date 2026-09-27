// Lambda entry point for the scheduled SES quota check (see email-quota-handler.ts).

import { GetAccountCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { createObservability, withObservability } from "../observability/index.js";
import { createEmailQuotaHandler } from "./email-quota-handler.js";

const obs = createObservability({ service: "ops" });
const ses = new SESv2Client({ region: obs.region });

export const handler = withObservability(
  obs,
  createEmailQuotaHandler({
    obs,
    getSendQuota: async () => {
      const { SendQuota } = await ses.send(new GetAccountCommand({}));
      return { max24HourSend: SendQuota?.Max24HourSend ?? 0, sentLast24Hours: SendQuota?.SentLast24Hours ?? 0 };
    },
  }),
);
