# 0008. Read receipts with Claude on Amazon Bedrock

- Status: Accepted
- Date: 2026-09-28 (proposed 2026-09-25)
- Note: The owner accepted this with changes on 2026-09-28, before it was built. An HTTP API stops waiting after 30 seconds, so the model call times out at about 25 seconds, not 60. Claude Haiku 4.5 only caches a prefix of 4,096 tokens or more, so the cache breakpoint goes after the inventory list, not after the instructions. The monthly receipt limit follows from the model the eval picks.
- Note: On 2026-10-01 the owner dropped the team setting to keep receipt photos (encrypted S3, 90-day lifecycle) from the MVP. Photos are never stored. The setting may return as a phase-2 feature.
- Note: On 2026-10-01 the owner enabled Claude in the prod account in us-east-1 (supply-checkout-fy9). Test calls to Claude Haiku 4.5 and Claude Sonnet 4.6 through their `us.` inference profiles worked. Claude Sonnet 5 (`us.anthropic.claude-sonnet-5`) and Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`) were refused as not available for this account, which AWS gates for new accounts, so the eval benchmarks against Sonnet 4.6 instead. Retry Sonnet 5.x later, or ask AWS for access. Quotas are the defaults for now.
- Note: As built (supply-checkout-kx8, 2026-10-01): the client is `AnthropicBedrock` (Bedrock's InvokeModel API), not `AnthropicBedrockMantle`. The Mantle endpoint takes `anthropic.` model IDs rather than the `us.` inference profiles chosen below, is authorized by `bedrock-mantle:CreateInference` rather than `bedrock:InvokeModel`, and doesn't support structured outputs; InvokeModel does all three as this decision describes. The route is `POST /teams/{teamId}/receipts/read` (a plain path segment rather than `receipts:read`). The monthly limit is provisionally 200 receipts per team for every plan until supply-checkout-akz and supply-checkout-wxx.
- Note: As built (supply-checkout-wxx, 2026-10-01): the owner set the provisional allowances at 200 receipts a month for paying and comped teams and 25 for a whole trial (not per month), until supply-checkout-akz. The per-user rate limit is 10 a minute, 60 an hour and 200 a day, from all of a user's teams together. A read the model service refused before billing anything is given back to the team; timeouts and bad replies still count.

## Context

Receipt reading is the feature that sells the product. Today the app sends the photo and `RECEIPT_PROMPT` (plus up to 500 inventory lines) through `window.claude.use("sample").json(...)`. The review screen then lets the user check and assign every line before anything is saved. Mistakes here become wrong client charges, so accuracy matters more than cost. Cost still has to fit inside $3 per user per month.

## Decision

- **Where it runs**: a `receipts` Lambda behind the authenticated HTTP API (`POST /teams/{id}/receipts:read`). AWS credentials stay in the Lambda's execution role; the browser never talks to Bedrock.
- **Client**: the Anthropic TypeScript SDK's Bedrock client, `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`, which uses the Messages API.
- **Model**: start with **Claude Haiku 4.5** (`us.anthropic.claude-haiku-4-5-20251001-v1:0`). Before launch, run an eval on 30–50 of our own real, messy receipts against **Claude Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`), scoring line items, quantities, unit prices and inventory matches. Pick the cheapest model that matches Sonnet's line-item accuracy. The model ID is configuration, not code, so it can change without a release: `RECEIPT_MODEL_ID` and `RECEIPT_BENCHMARK_MODEL_ID` in `infra/lib/config.ts`.
- **Inference profile**: both IDs are US cross-region inference profiles (the `us.` prefix). Bedrock may route each request to any US region the profile covers, so data stays in US regions. A `global.` profile could route requests outside the US, so it isn't used.
- **Output**: use **structured outputs** (`output_config.format` with a JSON schema that matches the shape the review screen already reads: `store`, `date`, `items[]` with `raw`, `name`, `qty`, `price`, `match`, and `subtotal`, `tax`, `total`). This replaces "reply with only JSON" in the prompt and removes the `invalid_json` failure.
- **Prompt caching**: put the fixed instructions first with a cache breakpoint, then the team's inventory list, then the image. Repeat scans within minutes reuse the cache.
- **Photo handling**: the phone shrinks the photo in the browser to at most 1568 px on the long edge as a JPEG (about 200–500 KB). That keeps requests well under Lambda's 6 MB payload limit and cuts image tokens. Photos are sent in the request body and **not stored**.
- **Guardrails**:
  - checks membership (contributor or owner) and an active subscription
  - a per-team monthly receipt limit that depends on the plan, counted with an atomic counter
  - a per-user rate limit (for example 10 a minute)
  - request timeout of 60 seconds and cancellation (the existing Stop button)
  - log token usage for every call to a CloudWatch metric, so cost per team can be checked
- **Untrusted content**: the receipt image is data, not instructions. The schema limits what the model can return, and nothing is saved until the user confirms on the review screen, which is how the app already works.

## Cost

At Anthropic's list prices (Haiku 4.5: $1 / $5 per million input/output tokens; Sonnet 5: $2 / $10), with about 1,600 image tokens, 1–3k prompt and inventory tokens and about 500 output tokens per receipt:

| Model | Per receipt | 100 receipts a month |
| --- | --- | --- |
| Haiku 4.5 | about $0.005–0.007 | about $0.60 |
| Sonnet 5 | about $0.01–0.015 | about $1.30 |

Sonnet 5 is in the table because it was the planned benchmark. The eval now benchmarks against Sonnet 4.6 (see the note above), which costs more per token, but it's used only for the eval, not in production. Bedrock sets its own Claude pricing. Check the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/) before finalizing plan limits.

## Alternatives considered

- **Amazon Textract AnalyzeExpense.** Good at receipt fields, but can't match lines against the team's inventory or rewrite abbreviated names. Would need a second model call anyway.
- **Anthropic's API directly.** Same models with the newest features first, but adds a second vendor contract and a second data processor. Bedrock keeps data and billing inside AWS, and Bedrock doesn't use prompts or outputs to train models.

## Consequences

- One-time setup: enable Anthropic models in the Bedrock console in both regions (first time needs a short use-case form).
- IAM for the receipts Lambda (supply-checkout-kx8): invoking an inference profile needs `bedrock:InvokeModel` on the inference-profile ARN and on the underlying foundation-model ARNs in every region the profile routes to, not only the Lambda's own region.
- Bedrock is used from both regions ([ADR 0010](0010-multi-region-active-active.md)); per-region quotas are requested ahead of launch.
- Keeping receipt photos for a team's own records (encrypted S3, 90-day lifecycle) is a possible phase-2 feature, not part of the MVP. The Terms and the privacy policy would need to change first.
