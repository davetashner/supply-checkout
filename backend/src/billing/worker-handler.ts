// The billing worker's SQS handler (see worker.ts). Reports each message it
// couldn't apply as a batch item failure; on a FIFO queue, a failure also
// fails every later message in the same group (customer), so a customer's
// events are never applied out of order.

import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import { parseSeatSync } from "./seats.js";
import { parseMessage, type QueueMessage } from "./worker.js";

/**
 * `seatQueueArn` is the seat sync queue's: a record from it must be a seat
 * sync, and a record from anywhere else (the billing queue) a Stripe event,
 * so nothing that can send seat syncs can pass one off as an event.
 */
export function createWorkerHandler(apply: (message: QueueMessage) => Promise<unknown>, obs: Observability, seatQueueArn?: string) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failedGroups = new Set<string>();
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      const group = record.attributes.MessageGroupId ?? "";
      if (failedGroups.has(group)) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        await apply(seatQueueArn !== undefined && record.eventSourceARN === seatQueueArn ? parseSeatSync(record.body) : parseMessage(record.body));
      } catch (error) {
        // The error's name only: a Stripe or DynamoDB message can echo request data
        obs.logger.error("Billing event failed", { messageId: record.messageId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
        failedGroups.add(group);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
