// The billing queue's sender: one FIFO message per verified Stripe event,
// grouped by customer and deduplicated by event ID (webhook-handler.ts).

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { BillingMessage, BillingQueue } from "./webhook-handler.js";

/** What the sender needs from an SQS client: `send`, as SQSClient has it. */
export interface SqsSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

export function sqsBillingQueue(queueUrl: string, sqs: SqsSender = new SQSClient({})): BillingQueue {
  return async (message: BillingMessage, group: string, deduplicationId: string) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: group, MessageDeduplicationId: deduplicationId }));
  };
}
