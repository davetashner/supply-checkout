// The post confirmation trigger that records the address an email change is
// told to (NOTICE_ADDRESS, supply-checkout-8jc.31), the moment a native user
// confirms their sign-up with Cognito's email code (or a forgotten password):
// before they have a token, so before anyone could change the email with one.
// Until this, an account got its address only at its first GET /me, so an
// email change made before then (by someone holding its token, straight
// against Cognito) was recorded and nobody was told.
//
// The rule is GET /me's (notice-address.ts): only an address the account API
// would trust, never over one already recorded, never for an account being
// deleted. A Google or Apple user's email isn't verified yet at this point
// (the pre token generation trigger verifies it), so they get theirs there.
//
// Cognito reports a failed post confirmation trigger to the client after the
// user is confirmed, so this never throws: a failure is logged with the
// error's name only and counted (SecurityNoticeFailures, reason
// `record_address`), and the account's first GET /me or token records it.
// Logs carry the outcome only, never the email, username or sub.

import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { NoticeAddressOutcome, RememberNoticeAddress } from "./notice-address.js";

export interface PostConfirmationDeps {
  readonly rememberNoticeAddress: RememberNoticeAddress;
  readonly obs: Observability;
}

export function createPostConfirmationHandler(deps: PostConfirmationDeps) {
  return async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    let outcome: NoticeAddressOutcome | "failed";
    try {
      outcome = await deps.rememberNoticeAddress(event.userName, event.request?.userAttributes ?? {});
    } catch (error) {
      outcome = "failed";
      deps.obs.logger.error("Notice address not recorded", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "emailChanged", reason: "record_address", via: "sign-up" });
    }
    deps.obs.logger.info("Notice address", { triggerSource: String(event.triggerSource), outcome });
    return event;
  };
}
