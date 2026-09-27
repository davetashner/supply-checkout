// The SES sending-quota check (supply-checkout-134), run on a schedule in the
// primary region, where the app sends email.
//
// SES has no metric for the quota, and its limit is a rolling 24 hours, which
// a CloudWatch sum of `Send` over fixed periods can't match. So this check asks
// SES itself (GetAccount: sends in the last 24 hours and the 24-hour maximum)
// and sends the share used as the EmailQuotaUsedPercent gauge. The "Near the
// sending limit" alarm (docs/journeys.md, J3) fires above 80%. An unlimited
// quota (SES reports -1) is 0%.

import { BusinessMetric, type Observability } from "../observability/index.js";

export interface SendQuota {
  /** The most messages SES sends in 24 hours; -1 for no limit. */
  readonly max24HourSend: number;
  /** Messages sent in the last 24 hours. */
  readonly sentLast24Hours: number;
}

export interface EmailQuotaDeps {
  readonly getSendQuota: () => Promise<SendQuota>;
  readonly obs: Observability;
}

/** Sends in the last 24 hours as a percentage of the quota, to one decimal place. */
export function quotaUsedPercent(quota: SendQuota): number {
  if (!(quota.max24HourSend > 0) || !(quota.sentLast24Hours > 0)) return 0;
  return Math.round((1000 * quota.sentLast24Hours) / quota.max24HourSend) / 10;
}

export function createEmailQuotaHandler(deps: EmailQuotaDeps) {
  const { obs } = deps;
  return async (): Promise<{ usedPercent: number }> => {
    const quota = await deps.getSendQuota();
    const usedPercent = quotaUsedPercent(quota);
    obs.gauge(BusinessMetric.EmailQuotaUsedPercent, usedPercent, "Percent");
    obs.logger.info("Checked the SES quota", { usedPercent, sentLast24Hours: quota.sentLast24Hours, max24HourSend: quota.max24HourSend });
    return { usedPercent };
  };
}
