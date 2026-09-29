import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ROUTES, AUTH_ROUTES, BILLING_ROUTES, DATA_ROUTES, OPS_ROUTES, routeKey, WEBHOOK_ROUTES } from "../../backend/src/api/routes.js";
import {
  BILLING_READ_ATTRIBUTES,
  BILLING_UPDATE_ATTRIBUTES,
  COMP_ATTRIBUTES,
  CUSTOMER_LINK_TEAM_ATTRIBUTES,
  IMPORT_INDEX_ATTRIBUTES,
  INVITE_LIMIT_ATTRIBUTES,
  MEMBER_ROW_ATTRIBUTES,
  MEMBER_SEAT_ATTRIBUTES,
  OWNER_OPERATOR_AUDIT_ATTRIBUTES,
  REOPEN_ATTRIBUTES,
  STRIPE_LINK_ATTRIBUTES,
  STRIPE_LINK_READ_ATTRIBUTES,
  STUCK_IMPORT_ATTRIBUTES,
  WEBHOOK_RECORD_ATTRIBUTES,
} from "../../backend/src/data/schema.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { apiOutputParameters } from "../lib/stacks/api-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names come from lib/config.ts only (ADR 0010)
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function api(region: string = EAST, context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  // Bundling is skipped in tests (it needs backend/node_modules); `npm run synth` bundles for real
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [], ...context } });
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  const stack = stacks.regions[region]?.api;
  if (!stack) throw new Error(`No api stack in ${region}`);
  return { stack, template: Template.fromStack(stack) };
}

type Resource = { Properties: Record<string, unknown>; [k: string]: unknown };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];

describe("HTTP API routes", () => {
  it("serves every data, account, billing, auth and ops route in the primary region, the ops routes nowhere else, and no others", () => {
    const { template } = api();
    const keys = resources(template, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey).sort();
    expect(keys).toEqual([...DATA_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES, ...WEBHOOK_ROUTES, ...AUTH_ROUTES, ...OPS_ROUTES].map(routeKey).sort());
    const west = resources(api(WEST).template, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey).sort();
    expect(west).toEqual([...DATA_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES, ...WEBHOOK_ROUTES, ...AUTH_ROUTES].map(routeKey).sort());
    // The inventory commands and the stock history, next to the document routes
    expect(keys).toEqual(
      expect.arrayContaining([
        "POST /teams/{teamId}/sheets/{sheetId}/checkout",
        "POST /teams/{teamId}/sheets/{sheetId}/return",
        "POST /teams/{teamId}/products/{key}/stock",
        "GET /teams/{teamId}/products/{key}/movements",
      ]),
    );
  });

  it("puts the customer pool's JWT authorizer on every data, account and billing route, the operator pool's on every ops route, and none on the auth routes", () => {
    const { template } = api();
    const authorizers = resources(template, "AWS::ApiGatewayV2::Authorizer");
    expect(authorizers).toHaveLength(2);
    const [authorizerId, authorizer] = authorizers.find(([, a]) => a.Properties.Name === "cognito-jwt") as [string, Resource];
    const [opsAuthorizerId, opsAuthorizer] = authorizers.find(([, a]) => a.Properties.Name === "ops-cognito-jwt") as [string, Resource];
    expect(authorizer.Properties).toMatchObject({ AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"] });
    // Each checks its own pool's issuer and client: a token from one fails the other
    const jwt = (a: Resource) => JSON.stringify(a.Properties.JwtConfiguration);
    expect(jwt(authorizer)).toMatch(/identityissuerurl/i);
    expect(jwt(authorizer)).toMatch(/identitywebclientid/i);
    expect(jwt(opsAuthorizer)).toMatch(/identityopsissuerurl/i);
    expect(jwt(opsAuthorizer)).toMatch(/identityopsclientid/i);
    expect(jwt(opsAuthorizer)).not.toMatch(/webclientid|identityissuerurl/i);
    for (const [, route] of resources(template, "AWS::ApiGatewayV2::Route")) {
      const key = route.Properties.RouteKey as string;
      if ([...DATA_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES].some((r) => routeKey(r) === key)) {
        expect(route.Properties, key).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: { Ref: authorizerId } });
      } else if (OPS_ROUTES.some((r) => routeKey(r) === key)) {
        expect(route.Properties, key).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: { Ref: opsAuthorizerId } });
      } else {
        expect(route.Properties.AuthorizationType ?? "NONE", key).toBe("NONE");
      }
    }
  });

  it("routes data, account, billing, auth and ops requests to their functions' live aliases", () => {
    const { template } = api();
    const integrations = resources(template, "AWS::ApiGatewayV2::Integration").map(([, r]) => JSON.stringify(r.Properties.IntegrationUri));
    expect(integrations).toHaveLength(6);
    for (const fn of ["DataFunctionLive", "AccountFunctionLive", "BillingFunctionLive", "BillingWebhookFunctionLive", "AuthFunctionLive", "OpsFunctionLive"]) expect(integrations.some((i) => i.includes(fn)), fn).toBe(true);
    template.resourcePropertiesCountIs("AWS::Lambda::Alias", { Name: "live" }, 6);
  });

  it("allows only the app's origin (and localhost outside prod), with credentials for the cookie", () => {
    const cors = (t: Template) => (resources(t, "AWS::ApiGatewayV2::Api")[0]?.[1].Properties.CorsConfiguration ?? {}) as Record<string, unknown>;
    expect(cors(api().template)).toMatchObject({ AllowOrigins: ["https://app.supplycheckout.com"], AllowCredentials: true, AllowHeaders: ["authorization", "content-type", "idempotency-key"] });
    const staging = api(WEST, {}, { envName: "staging", regions: [WEST], primaryRegion: WEST }).template;
    expect(cors(staging).AllowOrigins).toEqual(["https://app.staging.supplycheckout.com", "http://localhost:5173"]);
  });

  it("turns off the execute-api endpoint, logs access as JSON and throttles the stage", () => {
    const { template } = api();
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { DisableExecuteApiEndpoint: true, ProtocolType: "HTTP" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 },
      AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('"latencyMs":\\$context.responseLatency,') },
    });
  });

  it("throttles each account and billing route and the CSV import below the stage, /me included", () => {
    const { template } = api();
    const [[, stage]] = resources(template, "AWS::ApiGatewayV2::Stage") as [[string, Resource]];
    expect(stage.Properties.RouteSettings).toEqual({
      "POST /teams/{teamId}/imports": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /me": { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      "POST /teams": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "POST /invites/{inviteId}/accept": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "GET /teams/{teamId}/members": { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      "PATCH /teams/{teamId}/members/{userId}": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "DELETE /teams/{teamId}/members/{userId}": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "GET /teams/{teamId}/invites": { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      "POST /teams/{teamId}/invites": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "DELETE /teams/{teamId}/invites/{inviteId}": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "POST /teams/{teamId}/invites/{inviteId}/resend": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /teams/{teamId}/close": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /teams/{teamId}/reopen": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "DELETE /me": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /me/email/code": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /me/email/verify": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "POST /me/password": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /me/mfa/totp": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /me/mfa/totp/verify": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /me/sign-out-everywhere": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /teams/{teamId}/billing/checkout": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /teams/{teamId}/billing/portal": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /billing/webhook": { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 50 },
      "GET /ops/teams": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /ops/teams/{teamId}": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "PUT /ops/teams/{teamId}/comp": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "DELETE /ops/teams/{teamId}/comp": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /ops/teams/{teamId}/reopen": { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
      "GET /ops/audit": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /ops/imports": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /ops/teams/{teamId}/imports/{importId}/clear": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
    });
    // Created after the routes it names
    expect((stage.DependsOn as string[]).filter((d) => d.startsWith("HttpApi")).length).toBeGreaterThanOrEqual(ACCOUNT_ROUTES.length + 1);
  });

  it("serves api.<env domain> with TLS 1.2 and latency records per region", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
        DomainName: "api.supplycheckout.com",
        DomainNameConfigurations: [Match.objectLike({ SecurityPolicy: "TLS_1_2", EndpointType: "REGIONAL" })],
      });
      template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
      for (const type of ["A", "AAAA"]) {
        template.hasResourceProperties("AWS::Route53::RecordSet", { Name: "api.supplycheckout.com.", Type: type, Region: region, SetIdentifier: `api-${region}` });
      }
    }
  });

  it("publishes the API ID and URL to SSM", () => {
    const { template } = api();
    const out = apiOutputParameters("prod");
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.apiId });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: out.url, Value: "https://api.supplycheckout.com" });
  });
});

describe("functions", () => {
  it("run Node.js 24 on arm64, with the data function at 1 GB, and the ops and reopen functions in the primary region only", () => {
    const { template } = api();
    const fns = resources(template, "AWS::Lambda::Function").map(([id, r]) => [id, r.Properties] as const);
    expect(fns).toHaveLength(8);
    expect(fns.some(([id]) => id.startsWith("OpsFunction"))).toBe(true);
    expect(fns.some(([id]) => id.startsWith("OpsReopenFunction"))).toBe(true);
    expect(resources(api(WEST).template, "AWS::Lambda::Function").some(([id]) => id.startsWith("Ops"))).toBe(false);
    for (const [id, p] of fns) expect(p).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: id.startsWith("BillingWorker") ? 30 : 10, TracingConfig: { Mode: "Active" } });
    expect(fns.find(([id]) => id.startsWith("DataFunction"))?.[1].MemorySize).toBe(1024);
  });

  it("give the data function the table name and the data-access role, and the auth function Cognito's settings", () => {
    const { template } = api();
    const env = (prefix: string) =>
      (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith(prefix))?.[1].Properties.Environment as { Variables: Record<string, unknown> })
        .Variables;
    expect(env("DataFunction")).toMatchObject({ TABLE_NAME: "supply-checkout-prod-app", DATA_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^DataAccessRole/), "Arn"] } });
    expect(env("AccountFunction")).toMatchObject({
      TABLE_NAME: "supply-checkout-prod-app",
      ISSUER_URL: { Ref: expect.stringMatching(/issuerurl/i) },
      ACCOUNT_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^AccountAccessRole/), "Arn"] },
    });
    expect(env("AuthFunction")).toMatchObject({ AUTH_URL: { Ref: expect.stringMatching(/authurl/i) }, CLIENT_ID: { Ref: expect.stringMatching(/webclientid/i) }, ALLOWED_ORIGINS: "https://app.supplycheckout.com" });
  });

  it("don't give any function's own role DynamoDB access", () => {
    const { template } = api();
    for (const [id, policy] of resources(template, "AWS::IAM::Policy")) {
      expect(JSON.stringify(policy.Properties.PolicyDocument), id).not.toContain("dynamodb:");
    }
  });
});

describe("data-access role (LeadingKeys)", () => {
  const role = () => {
    const { template } = api();
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("DataAccessRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[]; MaxSessionDuration: number };
  };

  it("can be assumed only by the data function's role, with exactly one teamId session tag", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^DataFunctionRole/), "Arn"] } },
      Condition: { StringLike: { "aws:RequestTag/teamId": "?*" }, "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId"] } },
    });
  });

  it("reaches only items in the session team's partitions, and only through the item and query actions", () => {
    const [policy] = role().Policies;
    const [items, opsAudit, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    // Owners read what operators did to their team: read only, without the operator's identity (ADR 0015)
    expect(opsAudit).toEqual({
      Sid: "OwnOperatorAuditReadOnly",
      Effect: "Allow",
      Action: "dynamodb:Query",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["OPAUDIT#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...OWNER_OPERATOR_AUDIT_ATTRIBUTES] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(OWNER_OPERATOR_AUDIT_ATTRIBUTES).not.toContain("operatorSub");
    expect(JSON.stringify(opsAudit?.Resource)).not.toMatch(/index|\*/);
    expect(rest).toEqual([]);
    expect(items).toMatchObject({
      Sid: "TeamItemsOnly",
      Effect: "Allow",
      // UpdateItem and ConditionCheckItem: the inventory commands' transactions. No Scan, no batch writes.
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}", "TEAM#${aws:PrincipalTag/teamId}#SHEETS"] } },
    });
    const resourcesJson = JSON.stringify(items?.Resource);
    expect(resourcesJson).toContain(":table/supply-checkout-prod-app");
    expect(resourcesJson).toContain("/index/GSI1");
    expect(resourcesJson).not.toContain("*");
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
  });

  it("is the only thing the data function may assume", () => {
    const { template } = api();
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          { Action: ["sts:AssumeRole", "sts:TagSession"], Effect: "Allow", Resource: { "Fn::GetAtt": [Match.stringLikeRegexp("^DataAccessRole"), "Arn"] } },
        ]),
      },
    });
  });
});

describe("account-access role (LeadingKeys)", () => {
  const role = () => {
    const { template } = api();
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("AccountAccessRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[]; MaxSessionDuration: number };
  };

  it("can be assumed only by the account function's role, with the user, team, invitee, member and invite limit tags and no others", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^AccountFunctionRole/), "Arn"] } },
      Condition: {
        StringLike: { "aws:RequestTag/userId": "?*", "aws:RequestTag/teamId": "?*", "aws:RequestTag/invitee": "?*", "aws:RequestTag/member": "?*", "aws:RequestTag/inviteLimit": "?*" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["userId", "teamId", "invitee", "member", "inviteLimit"] },
      },
    });
  });

  it("reaches only the tagged user, team and invitee partitions, with item, transaction and query actions and no scan, a member's only to update or delete, and an invited address's counter only to update", () => {
    const [policy] = role().Policies;
    const [items, member, limit, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(items).toMatchObject({
      Sid: "CallerItemsOnly",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["USER#${aws:PrincipalTag/userId}", "TEAM#${aws:PrincipalTag/teamId}", "INVITEE#${aws:PrincipalTag/invitee}"],
        },
      },
    });
    const resourcesJson = JSON.stringify(items?.Resource);
    expect(resourcesJson).toContain(":table/supply-checkout-prod-app");
    expect(resourcesJson).toContain("/index/GSI2");
    expect(resourcesJson).not.toContain("GSI1");
    expect(resourcesJson).not.toContain("*");
    // Another member's partition: only updating or deleting items (their team-switcher row), on the table itself
    expect(member).toMatchObject({
      Sid: "MemberSwitcherRowOnly",
      Effect: "Allow",
      Action: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["USER#${aws:PrincipalTag/member}"], "dynamodb:Attributes": ["PK", "SK", "role"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    expect(Object.keys(member?.Condition as object).sort()).toEqual(["ForAllValues:StringEquals", "StringEqualsIfExists"]);
    // The same list the data layer's member-row writes are tested against (backend/test/members-api.test.ts)
    expect([...MEMBER_ROW_ATTRIBUTES]).toEqual(["PK", "SK", "role"]);
    expect(JSON.stringify(member?.Resource)).toContain(":table/supply-checkout-prod-app");
    expect(JSON.stringify(member?.Resource)).not.toContain("index");
    expect(JSON.stringify(member?.Resource)).not.toContain("*");
    // The invited address's daily counter: only UpdateItem, only its attributes, nothing returned
    expect(limit).toMatchObject({
      Sid: "InviteLimitCounterOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["INVITELIMIT#${aws:PrincipalTag/inviteLimit}"], "dynamodb:Attributes": ["PK", "SK", "count", "type", "expiresAt"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // The same list the data layer's counter writes are tested against (backend/test/invites-api.test.ts)
    expect([...INVITE_LIMIT_ATTRIBUTES]).toEqual(["PK", "SK", "count", "type", "expiresAt"]);
    expect(Object.keys(limit?.Condition as object).sort()).toEqual(["ForAllValues:StringEquals", "StringEqualsIfExists"]);
    expect(JSON.stringify(limit?.Resource)).toContain(":table/supply-checkout-prod-app");
    expect(JSON.stringify(limit?.Resource)).not.toContain("index");
    expect(JSON.stringify(limit?.Resource)).not.toContain("*");
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
  });

  it("lets the account function send invite emails, from noreply only, and nothing else in SES", () => {
    const { template } = api();
    const sends = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
      (p.Properties.PolicyDocument as { Statement: { Action: unknown; Condition?: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("ses:")).map((s) => [id, s]),
    );
    const noreply = expect.objectContaining({ Sid: "SendAppEmail", Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } } });
    // And the billing worker, for owners' billing notices
    expect(sends).toEqual([
      [expect.stringMatching(/^AccountFunctionRole/), noreply],
      [expect.stringMatching(/^BillingWorkerFunctionRole/), noreply],
    ]);
  });

  it("lets the account function put account deletion records, in the primary region's bucket, and no other function touch S3", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const s3 = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
        (p.Properties.PolicyDocument as { Statement: { Action: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("s3:")).map((s) => [id, s]),
      );
      expect(s3).toEqual([
        [
          expect.stringMatching(/^AccountFunctionRole/),
          {
            Sid: "PutAccountDeletionRecords",
            Effect: "Allow",
            Action: "s3:PutObject",
            Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }, "/users/*"]] },
            Condition: { Null: { "s3:if-none-match": "false" } },
          },
        ],
      ]);
      const fn = resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("AccountFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> };
      expect(fn.Variables).toMatchObject({
        DELETIONS_BUCKET: { "Fn::Join": ["", [`supply-checkout-prod-deletions-${EAST}-`, { Ref: "AWS::AccountId" }]] },
        DELETIONS_REGION: EAST,
      });
      // Neither the account-access role nor any other role reaches the bucket
      const roles = resources(template, "AWS::IAM::Role").filter(([, r]) => JSON.stringify(r.Properties).includes("s3:"));
      expect(roles).toEqual([]);
    }
  });

  it("is the only thing the account function may assume, and the data function can't", () => {
    const { template } = api();
    const assumes = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
      (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("sts:AssumeRole")).map((s) => [id, JSON.stringify(s.Resource)]),
    );
    expect(assumes.filter(([, r]) => /AccountAccessRole/.test(r as string)).map(([id]) => id)).toEqual([expect.stringMatching(/^AccountFunctionRole/)]);
    expect(assumes.filter(([, r]) => /DataAccessRole/.test(r as string)).map(([id]) => id)).toEqual([expect.stringMatching(/^DataFunctionRole/)]);
  });
});

describe("billing function and billing-access role (ADR 0009)", () => {
  const role = (template = api().template) => {
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("BillingAccessRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[]; MaxSessionDuration: number };
  };
  const env = (template: Template) =>
    (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("BillingFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;

  it("runs in every region, with the table, issuer, app URL, and the test-mode Stripe secret by name", () => {
    for (const region of [EAST, WEST]) {
      expect(env(api(region).template)).toMatchObject({
        TABLE_NAME: "supply-checkout-prod-app",
        ISSUER_URL: { Ref: expect.stringMatching(/issuerurl/i) },
        APP_URL: "https://app.supplycheckout.com",
        STRIPE_SECRET_ID: "supply-checkout/prod/stripe/test-secret-key",
        STRIPE_MODE: "test",
        BILLING_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^BillingAccessRole/), "Arn"] },
      });
    }
    expect(env(api(EAST, {}, { stripeMode: "live" }).template)).toMatchObject({ STRIPE_SECRET_ID: "supply-checkout/prod/stripe/live-secret-key", STRIPE_MODE: "live" });
  });

  it("lets only the billing function and worker read the Stripe secret key, and only the webhook its signing secret, each one secret in its own region", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const reads = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
        (p.Properties.PolicyDocument as { Statement: { Action: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("secretsmanager:")).map((s) => [id, s]),
      );
      // Secrets Manager's six random characters, and nothing else: no account ID written down
      const secret = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:secretsmanager:${region}:`, { Ref: "AWS::AccountId" }, `:secret:supply-checkout/prod/stripe/${name}-??????`]] });
      const key = { Sid: "ReadStripeSecretKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret("test-secret-key") };
      expect(reads).toEqual([
        [expect.stringMatching(/^BillingFunctionRole/), key],
        [expect.stringMatching(/^BillingWebhookFunctionRole/), { Sid: "ReadStripeWebhookSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret("test-webhook-secret") }],
        [expect.stringMatching(/^BillingWorkerFunctionRole/), key],
      ]);
      // No role reaches any secret
      expect(resources(template, "AWS::IAM::Role").filter(([, r]) => JSON.stringify(r.Properties).includes("secretsmanager:"))).toEqual([]);
    }
  });

  it("can be assumed only by the billing function's role, with the team and customer tags and no others", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^BillingFunctionRole/), "Arn"] } },
      Condition: {
        StringLike: { "aws:RequestTag/teamId": "?*", "aws:RequestTag/stripeCustomer": "?*" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId", "stripeCustomer"] },
      },
    });
  });

  it("reads only the tagged team, counts only its members' roles, updates only its Stripe customer, and puts only the tagged customer's link", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [read, members, update, link, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(read).toEqual({
      Sid: "TeamReadOnly",
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: expect.anything(),
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"] } },
    });
    // Checkout's seat quantity (supply-checkout-8jc.20): keys and roles only, and the request must name them
    expect(members).toEqual({
      Sid: "TeamMemberRolesOnly",
      Effect: "Allow",
      Action: "dynamodb:Query",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": ["PK", "SK", "role"] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(update).toEqual({
      Sid: "TeamStripeCustomerOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": ["PK", "SK", "stripeCustomerId", "closedAt"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    expect(link).toEqual({
      Sid: "StripeLinkOnly",
      Effect: "Allow",
      Action: "dynamodb:PutItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["STRIPE#${aws:PrincipalTag/stripeCustomer}"], "dynamodb:Attributes": ["PK", "SK", "type", "customerId", "teamId"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // The same lists the handler's requests are tested against (backend/test/billing-policy.ts)
    expect([...CUSTOMER_LINK_TEAM_ATTRIBUTES]).toEqual(["PK", "SK", "stripeCustomerId", "closedAt"]);
    expect([...STRIPE_LINK_ATTRIBUTES]).toEqual(["PK", "SK", "type", "customerId", "teamId"]);
    expect([...MEMBER_SEAT_ATTRIBUTES]).toEqual(["PK", "SK", "role"]);
    for (const s of [read, members, update, link]) {
      expect(JSON.stringify(s?.Resource)).toContain(":table/supply-checkout-prod-app");
      expect(JSON.stringify(s?.Resource)).not.toMatch(/index|\*/);
    }
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
  });

  it("is the only thing the billing function may assume, and no other function may assume it", () => {
    const { template } = api();
    const assumes = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
      (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("sts:AssumeRole")).map((s) => [id, JSON.stringify(s.Resource)]),
    );
    expect(assumes.filter(([, r]) => /BillingAccessRole/.test(r as string)).map(([id]) => id)).toEqual([expect.stringMatching(/^BillingFunctionRole/)]);
    expect(assumes.filter(([id]) => /^BillingFunctionRole/.test(id as string)).map(([, r]) => r)).toEqual([expect.stringMatching(/BillingAccessRole/)]);
  });
});

describe("Stripe webhook, billing queue and worker (ADR 0009)", () => {
  const worker = (template = api().template) => {
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("BillingWorkerRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[] };
  };
  const statements = (template: Template, prefix: string) =>
    resources(template, "AWS::IAM::Policy")
      .filter(([id]) => id.startsWith(prefix))
      .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);

  it("serves the webhook with no authorizer, from its own function's live alias", () => {
    const { template } = api();
    const [[, route]] = resources(template, "AWS::ApiGatewayV2::Route").filter(([, r]) => r.Properties.RouteKey === "POST /billing/webhook") as [[string, Resource]];
    expect(route.Properties.AuthorizationType ?? "NONE").toBe("NONE");
    expect(JSON.stringify(route.Properties.Target)).toBeDefined();
  });

  it("has a FIFO queue with SSE and TLS only, redriving to a FIFO dead-letter queue after 5 tries", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "supply-checkout-prod-billing-events.fifo",
        FifoQueue: true,
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 180,
        RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^BillingEventsDeadLetterQueue"), "Arn"] }, maxReceiveCount: 5 },
      });
      template.hasResourceProperties("AWS::SQS::Queue", { QueueName: "supply-checkout-prod-billing-events-dlq.fifo", FifoQueue: true, SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86400 });
      // Both refuse anything but TLS, as do the seat sync queue and its dead-letter queue
      expect(resources(template, "AWS::SQS::QueuePolicy").filter(([, p]) => JSON.stringify(p.Properties).includes("aws:SecureTransport"))).toHaveLength(4);
    }
  });

  it("lets the webhook only read its signing secret and send to the queue: no table, no Stripe key", () => {
    const { template } = api();
    const own = statements(template, "BillingWebhookFunctionRole");
    expect(own.map((s) => s.Action)).toEqual(["logs:CreateLogStream,logs:PutLogEvents".split(","), "secretsmanager:GetSecretValue", "sqs:SendMessage"]);
    expect(own.find((s) => s.Action === "sqs:SendMessage")?.Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^BillingEventsQueue/), "Arn"] });
    const env = (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("BillingWebhookFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env).toMatchObject({ STRIPE_MODE: "test", STRIPE_WEBHOOK_SECRET_ID: "supply-checkout/prod/stripe/test-webhook-secret", BILLING_QUEUE_URL: { Ref: expect.stringMatching(/^BillingEventsQueue/) } });
    expect(env).not.toHaveProperty("TABLE_NAME");
    expect(env).not.toHaveProperty("STRIPE_SECRET_ID");
  });

  it("lets the account function send seat syncs to their own queue, and never to the billing queue (supply-checkout-l50)", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const own = statements(template, "AccountFunctionRole");
      const sqs = own.filter((s) => JSON.stringify(s.Action).includes("sqs:"));
      expect(sqs).toEqual([expect.objectContaining({ Sid: "QueueSeatSyncs", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [expect.stringMatching(/^SeatSyncsQueue/), "Arn"] } })]);
      const env = (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("AccountFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(env).toMatchObject({ SEAT_QUEUE_URL: { Ref: expect.stringMatching(/^SeatSyncsQueue/) } });
      expect(env).not.toHaveProperty("BILLING_QUEUE_URL");
      // Still no Stripe key
      expect(JSON.stringify(own)).not.toContain("secretsmanager");
      // Only the webhook sends to the billing queue
      const senders = resources(template, "AWS::IAM::Policy").filter(([, p]) => (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.some((s) => JSON.stringify(s.Action).includes("sqs:SendMessage") && /BillingEventsQueue/.test(JSON.stringify(s.Resource))));
      expect(senders.map(([id]) => id)).toEqual([expect.stringMatching(/^BillingWebhookFunctionRole/)]);
    }
  });

  it("has a FIFO seat sync queue with SSE and TLS only, redriving to its own dead-letter queue, that the worker reads and knows by ARN", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "supply-checkout-prod-seat-syncs.fifo",
        FifoQueue: true,
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 180,
        RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^SeatSyncsDeadLetterQueue"), "Arn"] }, maxReceiveCount: 5 },
      });
      template.hasResourceProperties("AWS::SQS::Queue", { QueueName: "supply-checkout-prod-seat-syncs-dlq.fifo", FifoQueue: true, SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86400 });
      const mappings = resources(template, "AWS::Lambda::EventSourceMapping").map(([, m]) => m.Properties);
      expect(mappings.filter((m) => JSON.stringify(m.EventSourceArn).includes("SeatSyncsQueue"))).toEqual([
        // At most 5 at once, so the nightly fan-out stays under Stripe's rate limit (supply-checkout-8jc.21)
        expect.objectContaining({ BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"], FunctionName: { Ref: expect.stringMatching(/^BillingWorkerFunction/) }, ScalingConfig: { MaximumConcurrency: 5 } }),
      ]);
      // Stripe's own events aren't held back by it
      expect(mappings.filter((m) => JSON.stringify(m.EventSourceArn).includes("BillingEventsQueue")).map((m) => m.ScalingConfig)).toEqual([undefined]);
      const env = (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("BillingWorkerFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(env).toMatchObject({ SEAT_QUEUE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^SeatSyncsQueue/), "Arn"] } });
    }
  });

  it("runs the worker from the queue one event at a time, reporting failures per message", () => {
    const { template } = api();
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^BillingEventsQueue"), "Arn"] },
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
    const env = (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("BillingWorkerFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env).toMatchObject({ TABLE_NAME: "supply-checkout-prod-app", STRIPE_SECRET_ID: "supply-checkout/prod/stripe/test-secret-key", STRIPE_MODE: "test", BILLING_WORKER_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^BillingWorkerRole/), "Arn"] } });
  });

  it("lets only the worker assume the billing-worker role, with the event, customer and team tags and no others", () => {
    const [trust, ...rest] = worker().AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^BillingWorkerFunctionRole/), "Arn"] } },
      Condition: {
        StringLike: { "aws:RequestTag/eventId": "?*", "aws:RequestTag/stripeCustomer": "?*", "aws:RequestTag/teamId": "?*" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["eventId", "stripeCustomer", "teamId"] },
      },
    });
    const { template } = api();
    const assumes = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
      (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("sts:AssumeRole")).map((s) => [id, JSON.stringify(s.Resource)]),
    );
    expect(assumes.filter(([, r]) => /BillingWorkerRole/.test(r as string)).map(([id]) => id)).toEqual([expect.stringMatching(/^BillingWorkerFunctionRole/)]);
  });

  it("reaches only the event's records, the customer's link, and the team's billing attributes", () => {
    const [policy, ...others] = worker().Policies;
    expect(others).toEqual([]);
    const [records, link, read, update, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(records).toEqual({
      Sid: "EventRecordsOnly",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["WEBHOOK#${aws:PrincipalTag/eventId}"], "dynamodb:Attributes": [...WEBHOOK_RECORD_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues": "NONE" },
      },
    });
    expect(link).toEqual({
      Sid: "StripeLinkTeamOnly",
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["STRIPE#${aws:PrincipalTag/stripeCustomer}"], "dynamodb:Attributes": ["PK", "SK", "teamId"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(read).toEqual({
      Sid: "TeamBillingReadOnly",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...BILLING_READ_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(update).toEqual({
      Sid: "TeamBillingUpdateOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...BILLING_UPDATE_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // Never the purge's index keys or anything about documents or members' data beyond an owner's address
    expect(BILLING_UPDATE_ATTRIBUTES).not.toContain("purgeAfter");
    expect(BILLING_UPDATE_ATTRIBUTES).not.toContain("GSI1PK");
    expect([...STRIPE_LINK_READ_ATTRIBUTES]).toEqual(["PK", "SK", "teamId"]);
    for (const s of [records, link, read, update]) expect(JSON.stringify(s?.Resource)).not.toMatch(/index|\*/);
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb" });
  });
});

describe("operator-access role (ADR 0015)", () => {
  const role = () => {
    const { template } = api();
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("OperatorAccessRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[]; MaxSessionDuration: number };
  };

  it("can be assumed only by the ops function's role, with exactly one teamId session tag", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^OpsFunctionRole/), "Arn"] } },
      Condition: { StringLike: { "aws:RequestTag/teamId": "?*" }, "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId"] } },
    });
  });

  it("queries only the operators' index partitions, for projected attributes only; updates only comp attributes of the tagged team; and only appends operator audit", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [index, comp, stuckList, stuckClear, audit, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    // Stuck imports (supply-checkout-6uw.2): the check's partition, keys and progress only; and only a job's GSI1 keys
    expect(stuckList).toEqual({
      Sid: "StuckImportsListOnly",
      Effect: "Allow",
      Action: "dynamodb:Query",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["IMPORTS#COMMITTING"], "dynamodb:Attributes": [...STUCK_IMPORT_ATTRIBUTES] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(JSON.stringify(stuckList?.Resource)).toContain("/index/GSI1");
    expect(stuckClear).toEqual({
      Sid: "StuckImportIndexKeysOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...IMPORT_INDEX_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    expect([...IMPORT_INDEX_ATTRIBUTES]).toEqual(["PK", "SK", "GSI1PK", "GSI1SK"]);
    expect(JSON.stringify(stuckClear?.Resource)).not.toMatch(/index|\*/);
    expect(rest).toEqual([]);
    expect(index).toEqual({
      Sid: "OpsIndexProjectionOnly",
      Effect: "Allow",
      Action: "dynamodb:Query",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["OPS#TEAMS", "OPS#OWNERS#*", "OPS#AUDIT#*"] },
        // Never ALL_ATTRIBUTES, which would fetch unprojected attributes from the table
        StringEquals: { "dynamodb:Select": ["ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES"] },
      },
    });
    expect(JSON.stringify(index?.Resource)).toContain("/index/GSI3");
    expect(JSON.stringify(index?.Resource)).not.toMatch(/GSI1|GSI2/);
    expect(comp).toEqual({
      Sid: "CompAttributesOnly",
      Effect: "Allow",
      // No PutItem or DeleteItem in a team's partition, and no reads there at all
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...COMP_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
      },
    });
    // ADR 0009: never plan or status; and nothing about the team's data
    expect([...COMP_ATTRIBUTES]).toEqual(["PK", "SK", "type", "version", "compPlan", "compSeats", "compUntil", "compReason", "compBy", "compAt"]);
    expect(JSON.stringify(comp?.Resource)).not.toMatch(/index|\*/);
    expect(audit).toEqual({
      Sid: "OperatorAuditAppendOnly",
      Effect: "Allow",
      // No UpdateItem or DeleteItem: audit items can't be changed or removed
      Action: ["dynamodb:PutItem", "dynamodb:Query"],
      Resource: expect.anything(),
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["OPAUDIT#*"] } },
    });
    expect(JSON.stringify(audit?.Resource)).not.toContain("index");
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
    // Nothing reads a team's partition from the table: no GetItem, no Query there, no Scan anywhere
    expect(JSON.stringify(policy)).not.toMatch(/GetItem|Scan|Batch|DeleteItem|ConditionCheck/);
    // And no closure field: with closedAt and purgeAfter it could close a team and have the purge delete it (supply-checkout-6uw.6)
    expect(JSON.stringify(policy)).not.toMatch(/closedAt|closedBy|purgeAfter|owners/);
  });

  it("is the only thing the ops function may assume, and it may call only AdminListGroupsForUser on the operator pool in Cognito", () => {
    const { template } = api();
    const statements = resources(template, "AWS::IAM::Policy")
      .filter(([id]) => id.startsWith("OpsFunctionRole"))
      .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement);
    expect(statements.filter((s) => JSON.stringify(s.Action).includes("sts:")).map((s) => JSON.stringify(s.Resource))).toEqual([expect.stringMatching(/OperatorAccessRole/)]);
    expect(statements.map((s) => JSON.stringify(s.Resource)).join()).not.toMatch(/OperatorReopenRole/);
    const cognito = statements.filter((s) => JSON.stringify(s.Action).includes("cognito-idp:"));
    expect(cognito).toEqual([expect.objectContaining({ Action: "cognito-idp:AdminListGroupsForUser", Resource: { Ref: expect.stringMatching(/identityopsuserpoolarn/i) } })]);
    // No other function may assume the operator-access role
    const assumes = resources(template, "AWS::IAM::Policy").filter(([id, p]) => !id.startsWith("OpsFunctionRole") && /OperatorAccessRole/.test(JSON.stringify(p.Properties.PolicyDocument)));
    expect(assumes).toEqual([]);
    // Its one other grant: invoking the reopen function, unqualified, and nothing else in Lambda
    const lambda = statements.filter((s) => JSON.stringify(s.Action).includes("lambda:"));
    expect(lambda).toEqual([expect.objectContaining({ Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [expect.stringMatching(/^OpsReopenFunction[0-9A-F]+$/), "Arn"] } })]);
    // And sending a seat sync after a reopen: to the seat sync queue only, never the billing queue (supply-checkout-8jc.21)
    const sqs = statements.filter((s) => JSON.stringify(s.Action).includes("sqs:"));
    expect(sqs).toEqual([expect.objectContaining({ Sid: "QueueSeatSyncs", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [expect.stringMatching(/^SeatSyncsQueue/), "Arn"] } })]);
    const env = (resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("OpsFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env).toMatchObject({ SEAT_QUEUE_URL: { Ref: expect.stringMatching(/^SeatSyncsQueue/) } });
    expect(env).not.toHaveProperty("BILLING_QUEUE_URL");
  });

  it("gives the ops function the operator pool's settings and its role", () => {
    const { template } = api();
    const fn = resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("OpsFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> };
    expect(fn.Variables).toMatchObject({
      TABLE_NAME: "supply-checkout-prod-app",
      OPS_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^OperatorAccessRole/), "Arn"] },
      OPS_ISSUER_URL: { Ref: expect.stringMatching(/opsissuerurl/i) },
      OPS_CLIENT_ID: { Ref: expect.stringMatching(/opsclientid/i) },
      OPS_USER_POOL_ID: { Ref: expect.stringMatching(/opsuserpoolid/i) },
    });
  });
});

describe("operator reopen function and role (supply-checkout-6uw.6)", () => {
  const role = () => {
    const { template } = api();
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("OperatorReopenRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[]; MaxSessionDuration: number };
  };

  it("exists in the primary region only, with no route", () => {
    expect(resources(api(WEST).template, "AWS::IAM::Role").some(([id]) => id.startsWith("OperatorReopenRole"))).toBe(false);
    const { template } = api();
    const integrations = resources(template, "AWS::ApiGatewayV2::Integration").map(([, r]) => JSON.stringify(r.Properties));
    expect(integrations.some((i) => /OpsReopenFunction/.test(i))).toBe(false);
  });

  it("can be assumed only by the reopen function's role, with exactly one teamId session tag", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^OpsReopenFunctionRole/), "Arn"] } },
      Condition: { StringLike: { "aws:RequestTag/teamId": "?*" }, "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId"] } },
    });
    const { template } = api();
    const assumes = resources(template, "AWS::IAM::Policy").filter(([, p]) => /OperatorReopenRole/.test(JSON.stringify(p.Properties.PolicyDocument)));
    expect(assumes.map(([id]) => id)).toEqual([expect.stringMatching(/^OpsReopenFunctionRole/)]);
  });

  it("reads and updates only the tagged team's keys, version, owners and closure fields, returning nothing, and only appends to that team's operator audit", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [closure, audit, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(closure).toEqual({
      Sid: "ReopenClosureFieldsOnly",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...REOPEN_ATTRIBUTES] },
        // A GetItem without a projection would name no attributes and return the whole item
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues": "NONE" },
      },
    });
    // Nothing about the team's name, plan, status, members or data
    expect([...REOPEN_ATTRIBUTES]).toEqual(["PK", "SK", "type", "version", "owners", "closedAt", "closedBy", "purgeAfter", "purging", "GSI1PK", "GSI1SK"]);
    expect(JSON.stringify(closure?.Resource)).not.toMatch(/index|\*/);
    expect(audit).toEqual({
      Sid: "TeamOperatorAuditAppendOnly",
      Effect: "Allow",
      Action: ["dynamodb:PutItem", "dynamodb:Query"],
      Resource: expect.anything(),
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["OPAUDIT#${aws:PrincipalTag/teamId}"] } },
    });
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
    expect(JSON.stringify(policy)).not.toMatch(/Scan|Batch|DeleteItem|ConditionCheck/);
  });

  it("gives the reopen function its role and table, and the ops function the reopen function's name", () => {
    const { template } = api();
    const env = (prefix: string) => (resources(template, "AWS::Lambda::Function").find(([id]) => new RegExp(`^${prefix}[0-9A-F]{8}$`).test(id))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env("OpsReopenFunction")).toMatchObject({ TABLE_NAME: "supply-checkout-prod-app", OPS_REOPEN_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^OperatorReopenRole/), "Arn"] } });
    expect(env("OpsFunction")).toMatchObject({ OPS_REOPEN_FUNCTION: { Ref: expect.stringMatching(/^OpsReopenFunction[0-9A-F]{8}$/) } });
    const statements = resources(template, "AWS::IAM::Policy")
      .filter(([id]) => id.startsWith("OpsReopenFunctionRole"))
      .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement);
    // Its own role: its logs and assuming the reopen role, nothing else
    expect(statements.map((s) => s.Action)).toEqual(expect.arrayContaining([["sts:AssumeRole", "sts:TagSession"]]));
    expect(JSON.stringify(statements)).not.toMatch(/dynamodb:|lambda:|cognito/);
  });
});

describe("no role can manage users or groups (ADR 0015)", () => {
  it("never grants creating users or changing groups in any stack, so nothing but an SSO administrator can add an operator", () => {
    const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
    const stacks = addSupplyCheckout(app, config);
    for (const stack of stacks.all) {
      const template = Template.fromStack(stack);
      for (const type of ["AWS::IAM::Policy", "AWS::IAM::Role", "AWS::IAM::ManagedPolicy"]) {
        for (const [id, r] of resources(template, type)) {
          const text = JSON.stringify(r.Properties);
          expect(text, `${stack.stackName} ${id}`).not.toMatch(/AdminCreateUser|AdminAddUserToGroup|AdminRemoveUserFromGroup|CreateGroup|cognito-idp:\*|"Action":"\*"/);
        }
      }
    }
  });
});
