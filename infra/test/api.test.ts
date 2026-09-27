import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ROUTES, AUTH_ROUTES, DATA_ROUTES, routeKey } from "../../backend/src/api/routes.js";
import { INVITE_LIMIT_ATTRIBUTES, MEMBER_ROW_ATTRIBUTES } from "../../backend/src/data/schema.js";
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
  it("serves every data, account and auth route, and no others", () => {
    const { template } = api();
    const keys = resources(template, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey).sort();
    expect(keys).toEqual([...DATA_ROUTES, ...ACCOUNT_ROUTES, ...AUTH_ROUTES].map(routeKey).sort());
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

  it("puts the Cognito JWT authorizer on every data and account route and none on the auth routes", () => {
    const { template } = api();
    const [[authorizerId, authorizer]] = resources(template, "AWS::ApiGatewayV2::Authorizer") as [[string, Resource]];
    expect(authorizer.Properties).toMatchObject({ AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"] });
    for (const [, route] of resources(template, "AWS::ApiGatewayV2::Route")) {
      const key = route.Properties.RouteKey as string;
      if ([...DATA_ROUTES, ...ACCOUNT_ROUTES].some((r) => routeKey(r) === key)) {
        expect(route.Properties, key).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: { Ref: authorizerId } });
      } else {
        expect(route.Properties.AuthorizationType ?? "NONE", key).toBe("NONE");
      }
    }
  });

  it("routes data, account and auth requests to their functions' live aliases", () => {
    const { template } = api();
    const integrations = resources(template, "AWS::ApiGatewayV2::Integration").map(([, r]) => JSON.stringify(r.Properties.IntegrationUri));
    expect(integrations).toHaveLength(3);
    expect(integrations.some((i) => /DataFunctionLive/.test(i))).toBe(true);
    expect(integrations.some((i) => /AccountFunctionLive/.test(i))).toBe(true);
    expect(integrations.some((i) => /AuthFunctionLive/.test(i))).toBe(true);
    template.resourcePropertiesCountIs("AWS::Lambda::Alias", { Name: "live" }, 3);
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

  it("throttles each account route and the CSV import below the stage, /me included", () => {
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
      "DELETE /me": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
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
  it("run Node.js 24 on arm64, with the data function at 1 GB", () => {
    const { template } = api();
    const fns = resources(template, "AWS::Lambda::Function").map(([id, r]) => [id, r.Properties] as const);
    expect(fns).toHaveLength(3);
    for (const [, p] of fns) expect(p).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 10, TracingConfig: { Mode: "Active" } });
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
    const [items, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
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
    expect(sends).toEqual([[expect.stringMatching(/^AccountFunctionRole/), expect.objectContaining({ Sid: "SendAppEmail", Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } } })]]);
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
