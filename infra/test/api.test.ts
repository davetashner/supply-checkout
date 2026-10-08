import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ROUTES, AUTH_ROUTES, BILLING_ROUTES, DATA_ROUTES, OPS_ROUTES, PASSWORD_RESET_ROUTES, RECEIPT_ROUTES, routeKey, WEBHOOK_ROUTES } from "../../backend/src/api/routes.js";
import {
  BILLING_READ_ATTRIBUTES,
  COMP_DISCOUNT_AUDIT_ATTRIBUTES,
  BILLING_UPDATE_ATTRIBUTES,
  COMP_ATTRIBUTES,
  CUSTOMER_LINK_TEAM_ATTRIBUTES,
  TOTP_RECORD_ATTRIBUTES,
  IMPORT_INDEX_ATTRIBUTES,
  INVITE_LIMIT_ATTRIBUTES,
  MEMBER_ROW_ATTRIBUTES,
  MEMBER_SEAT_ATTRIBUTES,
  OWNER_OPERATOR_AUDIT_ATTRIBUTES,
  RECEIPT_RATE_ATTRIBUTES,
  RECEIPT_TRIAL_CAP_ATTRIBUTES,
  RECEIPT_TRIAL_READS_PER_DAY,
  RECEIPT_USAGE_ATTRIBUTES,
  TEST_MARK_ATTRIBUTES,
  REOPEN_ATTRIBUTES,
  STRIPE_LINK_ATTRIBUTES,
  STRIPE_LINK_READ_ATTRIBUTES,
  STUCK_IMPORT_ATTRIBUTES,
  WEBHOOK_RECORD_ATTRIBUTES,
} from "../../backend/src/data/schema.js";
import { APPROVED_REGIONS, type DeploymentConfig, RECEIPT_MODEL_ID, RECEIPT_MODEL_REGIONS } from "../lib/config.js";
import { apiOutputParameters } from "../lib/stacks/api-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names come from lib/config.ts only (ADR 0010)
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function api(region: string = EAST, context: Record<string, unknown> = {}, overrides: Partial<DeploymentConfig> = {}) {
  // Bundling is skipped in tests (it needs backend/node_modules); `npm run synth` bundles for real
  const app = testApp(context);
  const stacks = addSupplyCheckout(app, { ...config, ...overrides });
  const stack = stacks.regions[region]?.api;
  if (!stack) throw new Error(`No api stack in ${region}`);
  return { stack, template: Template.fromStack(stack) };
}

type Resource = { Properties: Record<string, unknown>; [k: string]: unknown };
/** The functions whose own roles read the password reset record (supply-checkout-6uw.33). */
const RESET_READERS = ["DataFunction", "AccountFunction", "BillingFunction", "ReceiptsFunction"] as const;
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];

describe("HTTP API routes", () => {
  it("serves every data, receipt, account, billing, auth, password reset and ops route in the primary region, the ops routes nowhere else, and no others", () => {
    const { template } = api();
    const keys = resources(template, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey).sort();
    expect(keys).toEqual([...DATA_ROUTES, ...RECEIPT_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES, ...WEBHOOK_ROUTES, ...AUTH_ROUTES, ...PASSWORD_RESET_ROUTES, ...OPS_ROUTES].map(routeKey).sort());
    const west = resources(api(WEST).template, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey).sort();
    expect(west).toEqual([...DATA_ROUTES, ...RECEIPT_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES, ...WEBHOOK_ROUTES, ...AUTH_ROUTES, ...PASSWORD_RESET_ROUTES].map(routeKey).sort());
    expect(keys).toContain("POST /teams/{teamId}/receipts/read");
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
      if ([...DATA_ROUTES, ...RECEIPT_ROUTES, ...ACCOUNT_ROUTES, ...BILLING_ROUTES].some((r) => routeKey(r) === key)) {
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
    expect(integrations).toHaveLength(8);
    for (const fn of ["DataFunctionLive", "ReceiptsFunctionLive", "AccountFunctionLive", "BillingFunctionLive", "BillingWebhookFunctionLive", "AuthFunctionLive", "PasswordResetFunctionLive", "OpsFunctionLive"]) expect(integrations.some((i) => i.includes(fn)), fn).toBe(true);
    template.resourcePropertiesCountIs("AWS::Lambda::Alias", { Name: "live" }, 8);
  });

  it("allows only the app's and the operator page's origins (and localhost outside prod), with credentials for the cookie", () => {
    const cors = (t: Template) => (resources(t, "AWS::ApiGatewayV2::Api")[0]?.[1].Properties.CorsConfiguration ?? {}) as Record<string, unknown>;
    expect(cors(api().template)).toMatchObject({
      AllowOrigins: ["https://app.supplycheckout.com", "https://ops.supplycheckout.com"],
      AllowCredentials: true,
      AllowHeaders: ["authorization", "content-type", "idempotency-key"],
    });
    const staging = api(WEST, {}, { envName: "staging", regions: [WEST], primaryRegion: WEST }).template;
    expect(cors(staging).AllowOrigins).toEqual(["https://app.staging.supplycheckout.com", "http://localhost:5173", "https://ops.staging.supplycheckout.com"]);
  });

  it("never lets the operator page's origin use the auth routes' cookie (supply-checkout-gxlt)", () => {
    // The auth handler checks Origin against ALLOWED_ORIGINS, so the ops origin, though in the
    // preflight's list, can't refresh or end a customer's session with the cookie
    const { template } = api();
    const origins = resources(template, "AWS::Lambda::Function")
      .map(([, f]) => (f.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.ALLOWED_ORIGINS)
      .filter((v): v is string => typeof v === "string");
    expect(origins.length).toBeGreaterThan(0);
    for (const value of origins) {
      expect(value).toBe("https://app.supplycheckout.com");
      expect(value).not.toContain("ops.");
    }
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
      "POST /teams/{teamId}/receipts/read": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /teams/{teamId}/receipts/usage": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
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
      "PATCH /me/preferences": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "POST /teams/{teamId}/billing/checkout": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /teams/{teamId}/billing/portal": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "GET /teams/{teamId}/billing/invoices": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /billing/webhook": { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 50 },
      "POST /auth/password-reset": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /auth/password-reset/confirm": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /ops/teams": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /ops/teams/{teamId}": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "PUT /ops/teams/{teamId}/comp": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "DELETE /ops/teams/{teamId}/comp": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "POST /ops/teams/{teamId}/reopen": { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
      "GET /ops/audit": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "GET /ops/imports": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "POST /ops/teams/{teamId}/imports/{importId}/clear": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "GET /ops/receipts": { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
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
    expect(fns).toHaveLength(10);
    expect(fns.some(([id]) => id.startsWith("OpsFunction"))).toBe(true);
    expect(fns.some(([id]) => id.startsWith("OpsReopenFunction"))).toBe(true);
    expect(resources(api(WEST).template, "AWS::Lambda::Function").some(([id]) => id.startsWith("Ops"))).toBe(false);
    // The receipts function waits on the model for up to 25 seconds, under API Gateway's 30
    const timeout = (id: string) => (id.startsWith("BillingWorker") ? 30 : id.startsWith("ReceiptsFunction") ? 29 : 10);
    for (const [id, p] of fns) expect(p).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: timeout(id), TracingConfig: { Mode: "Active" } });
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
      // The test mail domain, fixed in the template (supply-checkout-o60.2): only the account function makes teams
      TEST_MAIL_DOMAIN: "e2e.supplycheckout.com",
    });
    // No other API function needs it: they read a team's mark from its META item
    for (const [id, fn] of resources(template, "AWS::Lambda::Function")) {
      if (!id.startsWith("AccountFunction")) expect(JSON.stringify(fn.Properties.Environment ?? {}), id).not.toContain("TEST_MAIL_DOMAIN");
    }
    // AUTH_URL is fixed when the template is built, not read from SSM: the function sends the sign-in grant and the
    // refresh token there, so a rewritten parameter mustn't be able to move it (supply-checkout-6uw.23)
    expect(env("AuthFunction")).toMatchObject({ AUTH_URL: "https://auth.supplycheckout.com", CLIENT_ID: { Ref: expect.stringMatching(/webclientid/i) }, ALLOWED_ORIGINS: "https://app.supplycheckout.com" });
  });

  it("let the password reset function count only its request limits and invoke only the password reset function, in the primary region (supply-checkout-6uw.26)", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const [[id, fn]] = resources(template, "AWS::Lambda::Function").filter(([fid]) => fid.startsWith("PasswordResetFunction")) as [[string, Resource]];
      expect(fn.Properties.Environment).toMatchObject({
        Variables: {
          TABLE_NAME: "supply-checkout-prod-app",
          CLIENT_ID: { Ref: expect.stringMatching(/webclientid/i) },
          ISSUER_URL: { Ref: expect.stringMatching(/issuerurl/i) },
          ALLOWED_ORIGINS: "https://app.supplycheckout.com",
          PASSWORD_RESET_FUNCTION: "supply-checkout-prod-password-reset",
          PASSWORD_RESET_REGION: EAST,
        },
      });
      const role = (fn.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
      const statements = resources(template, "AWS::IAM::Policy")
        .filter(([, p]) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === role))
        .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);
      expect(statements, id).toEqual([
        expect.objectContaining({ Action: ["logs:CreateLogStream", "logs:PutLogEvents"] }),
        {
          Sid: "QueuePasswordResets",
          Effect: "Allow",
          Action: "lambda:InvokeFunction",
          Resource: { "Fn::Join": ["", [`arn:aws:lambda:${EAST}:`, { Ref: "AWS::AccountId" }, ":function:supply-checkout-prod-password-reset"]] },
        },
        {
          Sid: "CountPasswordResets",
          Effect: "Allow",
          Action: "dynamodb:UpdateItem",
          Resource: { "Fn::Join": ["", [`arn:aws:dynamodb:${region}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] },
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["RESETLIMIT#ADDRESS#*", "RESETLIMIT#IP#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "count", "expiresAt"] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        },
        expect.objectContaining({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } }),
        { Effect: "Allow", Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"], Resource: "*" },
      ]);
    }
  });

  it("don't give any function's own role DynamoDB access, but the password reset function's its limits' counters, and the reset time's read", () => {
    const { template } = api();
    for (const [id, policy] of resources(template, "AWS::IAM::Policy")) {
      if (id.startsWith("PasswordResetFunctionRole")) continue;
      const statements = (policy.Properties.PolicyDocument as { Statement: { Sid?: string }[] }).Statement.filter((s) => !(RESET_READERS.some((r) => id.startsWith(`${r}Role`)) && s.Sid === "ReadPasswordResetTime"));
      expect(JSON.stringify(statements), id).not.toContain("dynamodb:");
    }
  });

  // supply-checkout-6uw.33
  it("let the data, account, billing and receipts functions' own roles read only when a user's password was last reset", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const table = { "Fn::Join": ["", [`arn:aws:dynamodb:${region}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] };
      const readers = resources(template, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("ReadPasswordResetTime"));
      expect(readers.map(([id]) => id.replace(/RoleDefaultPolicy.*$/, "")).sort()).toEqual([...RESET_READERS].sort());
      for (const [id, policy] of readers) {
        const statements = (policy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
        expect(statements.filter((s) => s.Sid === "ReadPasswordResetTime"), id).toEqual([
          {
            Sid: "ReadPasswordResetTime",
            Effect: "Allow",
            Action: "dynamodb:GetItem",
            Resource: table,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
              "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "passwordResetAt"] },
              // Required: a GetItem without a projection mustn't read the whole item
              StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
            },
          },
        ]);
        // The table's key, through DynamoDB only
        expect(statements.filter((s) => s.Sid === "TableKeyThroughDynamoDb"), id).toEqual([
          expect.objectContaining({ Action: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"], Condition: { StringEquals: { "kms:ViaService": { "Fn::Join": ["", ["dynamodb.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } } } }),
        ]);
      }
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
      Action: ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      // The team's partition and its date index partitions: projects', and sheets' (the old name) until the rename's backfill is done
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}", "TEAM#${aws:PrincipalTag/teamId}#PROJECTS", "TEAM#${aws:PrincipalTag/teamId}#SHEETS"] } },
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
      Action: ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
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
      Action: ["dynamodb:DeleteItem", "dynamodb:UpdateItem"],
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

describe("receipts function and receipt-access role (ADR 0008)", () => {
  type Statement = Record<string, unknown> & { Sid?: string; Action: unknown; Resource: unknown; Condition?: unknown };
  const role = () => {
    const { template } = api();
    const [[, r]] = resources(template, "AWS::IAM::Role").filter(([id]) => id.startsWith("ReceiptAccessRole")) as [[string, Resource]];
    return r.Properties as { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] }; Policies: { PolicyDocument: { Statement: Statement[] } }[]; MaxSessionDuration: number };
  };
  const fnStatements = (t: Template) =>
    resources(t, "AWS::IAM::Policy")
      .filter(([id]) => id.startsWith("ReceiptsFunctionRole"))
      .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

  it("serves the receipt route with the customer pool's authorizer, from the receipts function in every region", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const [, route] = resources(template, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === "POST /teams/{teamId}/receipts/read") as [string, Resource];
      expect(route.Properties).toMatchObject({ AuthorizationType: "JWT" });
      const target = JSON.stringify(route.Properties.Target);
      const [integrationId] = resources(template, "AWS::ApiGatewayV2::Integration").find(([, i]) => JSON.stringify(i.Properties.IntegrationUri).includes("ReceiptsFunctionLive")) as [string, Resource];
      expect(target).toContain(integrationId);
    }
  });

  it("gives the function the model, the table and its role, 512 MB and 29 seconds", () => {
    const { template } = api();
    const [, fn] = resources(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("ReceiptsFunction")) as [string, Resource];
    expect(fn.Properties).toMatchObject({ MemorySize: 512, Timeout: 29 });
    // No reserved concurrency unless the context asks for it
    expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    const reserved = resources(api(EAST, { receiptsReservedConcurrency: "20" }).template, "AWS::Lambda::Function").filter(([, f]) => f.Properties.ReservedConcurrentExecutions !== undefined);
    expect(reserved.map(([id, f]) => [id.replace(/[0-9A-F]{8}$/, ""), f.Properties.ReservedConcurrentExecutions])).toEqual([["ReceiptsFunction", 20]]);
    expect((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({
      TABLE_NAME: "supply-checkout-prod-app",
      RECEIPT_MODEL_ID: RECEIPT_MODEL_ID,
      RECEIPT_ROLE_ARN: { "Fn::GetAtt": [expect.stringMatching(/^ReceiptAccessRole/), "Arn"] },
      // The account-wide trial cap: the backend's default unless the context sets it
      RECEIPT_TRIAL_READS_PER_DAY: String(RECEIPT_TRIAL_READS_PER_DAY),
    });
    const capped = resources(api(EAST, { receiptTrialReadsPerDay: "0" }).template, "AWS::Lambda::Function").find(([id]) => id.startsWith("ReceiptsFunction")) as [string, Resource];
    expect((capped[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.RECEIPT_TRIAL_READS_PER_DAY).toBe("0");
    expect(RECEIPT_MODEL_ID).toMatch(/^us\.anthropic\./);
  });

  it("can be assumed only by the receipts function's role, with exactly a teamId and a userId session tag", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^ReceiptsFunctionRole/), "Arn"] } },
      Condition: { StringLike: { "aws:RequestTag/teamId": "?*", "aws:RequestTag/userId": "?*" }, "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId", "userId"] } },
    });
  });

  it("reads only the session team's partition, and updates only its receipt counters' attributes and the session user's rate counters: no puts, no deletes, no index, no scan", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [read, count, rate, trials, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(read).toEqual({
      Sid: "TeamItemsReadOnly",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Resource: expect.anything(),
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"] } },
    });
    expect(count).toEqual({
      Sid: "ReceiptCountOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...RECEIPT_USAGE_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_NEW"] },
      },
    });
    expect(RECEIPT_USAGE_ATTRIBUTES).toEqual(["PK", "SK", "receipts"]);
    expect(rate).toEqual({
      Sid: "CallerReceiptRateOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["RECEIPTRATE#${aws:PrincipalTag/userId}"], "dynamodb:Attributes": [...RECEIPT_RATE_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // The account-wide trial cap (supply-checkout-i1d.3): one fixed partition, no tag in it, nothing returned
    expect(trials).toEqual({
      Sid: "TrialReceiptCapOnly",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["RECEIPTTRIALS"], "dynamodb:Attributes": [...RECEIPT_TRIAL_CAP_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // The only places this role may set a TTL; never in the team's partition
    expect(RECEIPT_RATE_ATTRIBUTES).toEqual(["PK", "SK", "count", "expiresAt"]);
    expect(RECEIPT_TRIAL_CAP_ATTRIBUTES).toEqual(["PK", "SK", "count", "expiresAt"]);
    expect(RECEIPT_USAGE_ATTRIBUTES).not.toContain("expiresAt");
    for (const s of [read, count, rate, trials]) {
      const json = JSON.stringify(s?.Resource);
      expect(json).toContain(":table/supply-checkout-prod-app");
      expect(json).not.toMatch(/index|\*/);
    }
    expect(kms).toMatchObject({ Sid: "TableKeyThroughDynamoDb", Condition: { StringEquals: { "kms:ViaService": expect.anything() } } });
  });

  it("lets the function invoke only the receipt model, through its US inference profile, in the regions the profile routes to", () => {
    for (const region of [EAST, WEST]) {
      const statements = fnStatements(api(region).template);
      const bedrock = statements.filter((s) => JSON.stringify(s.Action).includes("bedrock:"));
      expect(bedrock.map((s) => s.Action)).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModel"]);
      const [profile, model] = bedrock as [Statement, Statement];
      const profileArn = { "Fn::Join": ["", [`arn:aws:bedrock:${region}:`, { Ref: "AWS::AccountId" }, `:inference-profile/${RECEIPT_MODEL_ID}`]] };
      expect(profile).toEqual({ Sid: "InvokeReceiptProfile", Effect: "Allow", Action: "bedrock:InvokeModel", Resource: profileArn });
      const foundation = RECEIPT_MODEL_ID.replace(/^us\./, "");
      expect(model).toEqual({
        Sid: "InvokeReceiptModelThroughProfile",
        Effect: "Allow",
        Action: "bedrock:InvokeModel",
        Resource: RECEIPT_MODEL_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${foundation}`),
        Condition: { StringEquals: { "bedrock:InferenceProfileArn": profileArn } },
      });
      // Every region is a US one, and the function's own is among them
      expect(RECEIPT_MODEL_REGIONS.every((r) => r.startsWith("us-"))).toBe(true);
      expect(RECEIPT_MODEL_REGIONS).toContain(region);
      expect(JSON.stringify(bedrock)).not.toContain("*");
      // Besides Bedrock: writing its own logs, assuming its own role and reading when the caller's password was reset; nothing else
      const other = statements.filter((s) => !JSON.stringify(s.Action).includes("bedrock:")).map((s) => s.Action);
      expect(other).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"], ["sts:AssumeRole", "sts:TagSession"], "dynamodb:GetItem", ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]]);
    }
  });

  it("is the only function that may call Bedrock, and the only one that may assume the receipt-access role", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const policies = resources(template, "AWS::IAM::Policy");
      const bedrock = policies.filter(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("bedrock:")).map(([id]) => id);
      expect(bedrock).toEqual([expect.stringMatching(/^ReceiptsFunctionRole/)]);
      const assumes = policies.flatMap(([id, p]) =>
        (p.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("sts:AssumeRole") && /ReceiptAccessRole/.test(JSON.stringify(s.Resource))).map(() => id),
      );
      expect(assumes).toEqual([expect.stringMatching(/^ReceiptsFunctionRole/)]);
    }
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

  it("lets only the billing function and worker read the Stripe secret key, only the webhook its signing secret, and only the ops function the ops restricted key, each one secret in its own region", () => {
    for (const region of [EAST, WEST]) {
      const { template } = api(region);
      const reads = resources(template, "AWS::IAM::Policy").flatMap(([id, p]) =>
        (p.Properties.PolicyDocument as { Statement: { Action: unknown }[] }).Statement.filter((s) => JSON.stringify(s.Action).includes("secretsmanager:")).map((s) => [id, s]),
      );
      // Secrets Manager's six random characters, and nothing else: no account ID written down
      const secret = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:secretsmanager:${region}:`, { Ref: "AWS::AccountId" }, `:secret:supply-checkout/prod/stripe/${name}-??????`]] });
      const key = { Sid: "ReadStripeSecretKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret("test-secret-key") };
      // The ops function (primary region only) reads its own restricted key, and no other function can (supply-checkout-6uw.4)
      const opsKey = [expect.stringMatching(/^OpsFunctionRole/), { Sid: "ReadOpsStripeKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret("test-ops-restricted-key") }];
      expect(reads).toEqual([
        [expect.stringMatching(/^BillingFunctionRole/), key],
        [expect.stringMatching(/^BillingWebhookFunctionRole/), { Sid: "ReadStripeWebhookSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret("test-webhook-secret") }],
        [expect.stringMatching(/^BillingWorkerFunctionRole/), key],
        ...(region === EAST ? [opsKey] : []),
      ]);
      // No role reaches any secret
      expect(resources(template, "AWS::IAM::Role").filter(([, r]) => JSON.stringify(r.Properties).includes("secretsmanager:"))).toEqual([]);
    }
  });

  it("can be assumed only by the billing function's role, with the team, customer and user tags and no others", () => {
    const r = role();
    expect(r.MaxSessionDuration).toBe(3600);
    const [trust, ...rest] = r.AssumeRolePolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(trust).toMatchObject({
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Principal: { AWS: { "Fn::GetAtt": [expect.stringMatching(/^BillingFunctionRole/), "Arn"] } },
      Condition: {
        StringLike: { "aws:RequestTag/teamId": "?*", "aws:RequestTag/stripeCustomer": "?*", "aws:RequestTag/userId": "?*" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["teamId", "stripeCustomer", "userId"] },
      },
    });
  });

  it("reads only the tagged team, counts only its members' roles, updates only its Stripe customer, puts only the tagged customer's link, and reads and updates only the tagged user's totpOnAt", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [read, members, update, link, totpRead, totpUpdate, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
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
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["TEAM#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": ["PK", "SK", "stripeCustomerId", "closedAt", "version", "stripeCheckoutAt"] },
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
    // When the caller turned two-step sign-in on (supply-checkout-8jc.14): their own partition, that attribute only
    expect(totpRead).toEqual({
      Sid: "CallerTotpRecordRead",
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["USER#${aws:PrincipalTag/userId}"], "dynamodb:Attributes": ["PK", "SK", "totpOnAt"] },
        // Required, not IfExists: a GetItem without a projection is denied (supply-checkout-3sv.23)
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect(totpUpdate).toEqual({
      Sid: "CallerTotpRecordUpdate",
      Effect: "Allow",
      Action: "dynamodb:UpdateItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["USER#${aws:PrincipalTag/userId}"], "dynamodb:Attributes": ["PK", "SK", "totpOnAt"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    // The same lists the handler's requests are tested against (backend/test/billing-policy.ts)
    expect([...TOTP_RECORD_ATTRIBUTES]).toEqual(["PK", "SK", "totpOnAt"]);
    expect([...CUSTOMER_LINK_TEAM_ATTRIBUTES]).toEqual(["PK", "SK", "stripeCustomerId", "closedAt", "version", "stripeCheckoutAt"]);
    expect([...STRIPE_LINK_ATTRIBUTES]).toEqual(["PK", "SK", "type", "customerId", "teamId"]);
    expect([...MEMBER_SEAT_ATTRIBUTES]).toEqual(["PK", "SK", "role"]);
    for (const s of [read, members, update, link, totpRead, totpUpdate]) {
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
        // Deduplicated per customer, so no sender can drop another customer's sync (supply-checkout-8jc.26)
        DeduplicationScope: "messageGroup",
        FifoThroughputLimit: "perMessageGroupId",
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

  it("reaches only the event's records, the customer's link, the team's billing attributes, and puts of its comp discount audit", () => {
    const [policy, ...others] = worker().Policies;
    expect(others).toEqual([]);
    const [records, link, read, audit, update, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
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
    // The worker reads the team's test mark, for its metrics only (supply-checkout-o60.12), and can never write it
    expect(BILLING_READ_ATTRIBUTES).toContain("test");
    expect(BILLING_UPDATE_ATTRIBUTES).not.toContain("test");
    // The nightly entitlement check conditions its fix on the version it read (supply-checkout-8jc.27)
    expect(BILLING_READ_ATTRIBUTES).toContain("version");
    expect(BILLING_UPDATE_ATTRIBUTES).toContain("version");
    // supply-checkout-6e4b: PutItem only (append-only), the tagged team's operator audit only, an audit item's attributes only
    expect(audit).toEqual({
      Sid: "CompDiscountAuditPutOnly",
      Effect: "Allow",
      Action: "dynamodb:PutItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["OPAUDIT#${aws:PrincipalTag/teamId}"], "dynamodb:Attributes": [...COMP_DISCOUNT_AUDIT_ATTRIBUTES] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    });
    expect([...COMP_DISCOUNT_AUDIT_ATTRIBUTES]).not.toContain("reason");
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
    for (const s of [records, link, read, audit, update]) expect(JSON.stringify(s?.Resource)).not.toMatch(/index|\*/);
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

  it("queries only the operators' index partitions, for projected attributes only; updates only comp attributes of the tagged team; reads only teams' receipt counts and test marks; and only appends operator audit", () => {
    const [policy, ...others] = role().Policies;
    expect(others).toEqual([]);
    const [index, comp, stuckList, stuckClear, testMarks, receipts, audit, kms, ...rest] = policy?.PolicyDocument.Statement ?? [];
    // Test marks (supply-checkout-o60.2): BatchGetItem by key only, the keys and `test` only, projected; read only
    expect(testMarks).toEqual({
      Sid: "TeamTestMarksReadOnly",
      Effect: "Allow",
      Action: "dynamodb:BatchGetItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEST_MARK_ATTRIBUTES] },
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect([...TEST_MARK_ATTRIBUTES]).toEqual(["PK", "SK", "test"]);
    expect(JSON.stringify(testMarks?.Resource)).not.toMatch(/index|\*/);
    // Receipt usage (supply-checkout-wxx): BatchGetItem by key only, the keys and `receipts` only, projected
    expect(receipts).toEqual({
      Sid: "TeamReceiptCountersReadOnly",
      Effect: "Allow",
      Action: "dynamodb:BatchGetItem",
      Resource: expect.anything(),
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...RECEIPT_USAGE_ATTRIBUTES] },
        // Not IfExists: a batch read without a projection would return whole items
        StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    expect([...RECEIPT_USAGE_ATTRIBUTES]).toEqual(["PK", "SK", "receipts"]);
    expect(JSON.stringify(receipts?.Resource)).not.toMatch(/index|\*/);
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
    expect([...COMP_ATTRIBUTES]).toEqual(["PK", "SK", "type", "version", "compPlan", "compSeats", "compUntil", "compReason", "compBy", "compAt", "compMonths"]);
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
    // Nothing else reads a team's partition from the table: no GetItem, no Query there, no Scan anywhere,
    // and the batch reads are the receipt counters' and test marks' above
    expect(JSON.stringify({ ...policy, PolicyDocument: { Statement: (policy?.PolicyDocument.Statement ?? []).filter((x) => x !== receipts && x !== testMarks) } })).not.toMatch(/GetItem|Scan|Batch|DeleteItem|ConditionCheck/);
    // And nothing anywhere in it can write the test mark: it's in no statement but the read
    expect(JSON.stringify({ ...policy, PolicyDocument: { Statement: (policy?.PolicyDocument.Statement ?? []).filter((x) => x !== testMarks) } })).not.toMatch(/"test"/);
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
    // Its Stripe key is the ops restricted key, read by name: never the billing functions' secret key (supply-checkout-6uw.4)
    expect(env).toMatchObject({ STRIPE_OPS_KEY_SECRET_ID: "supply-checkout/prod/stripe/test-ops-restricted-key", STRIPE_MODE: "test" });
    expect(env).not.toHaveProperty("STRIPE_SECRET_ID");
    expect(JSON.stringify(statements)).not.toMatch(/secret-key|webhook-secret|kms:/);
    const live = (resources(api(EAST, {}, { stripeMode: "live" }).template, "AWS::Lambda::Function").find(([id]) => id.startsWith("OpsFunction"))?.[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(live).toMatchObject({ STRIPE_OPS_KEY_SECRET_ID: "supply-checkout/prod/stripe/live-ops-restricted-key", STRIPE_MODE: "live" });
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
    // Nothing about the team's name, plan, status, members or data: and the reopen's pending Stripe resync (supply-checkout-85qp)
    expect([...REOPEN_ATTRIBUTES]).toEqual(["PK", "SK", "type", "version", "owners", "closedAt", "closedBy", "purgeAfter", "purging", "GSI1PK", "GSI1SK", "stripeResyncFor", "stripeReopenedAt"]);
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
    const app = testApp();
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
