import { Aws, RemovalPolicy } from "aws-cdk-lib";
import type { AlarmBase, IAlarmAction } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Subscription, SubscriptionProtocol, Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * docs/journeys.md, "Severity and who is told". P3 has no topic: those are
 * trends for the weekly review, read from the dashboard.
 */
export type Severity = "P1" | "P2";

/**
 * How many alarm recipients of each kind to subscribe. The addresses and
 * numbers themselves are never in this repository (it's public): each one is
 * an SSM parameter in the account, in every region with an observability
 * stack, read by CloudFormation at deploy time. See alarmContactParameter.
 */
export interface AlarmContacts {
  /** Email recipients: told about P1 and P2 alarms. */
  readonly email: number;
  /** SMS recipients (E.164 numbers, e.g. +15555550100): told about P1 alarms only. */
  readonly sms: number;
}

export const DEFAULT_ALARM_CONTACTS: AlarmContacts = { email: 1, sms: 1 };
const MAX_CONTACTS = 5;

/**
 * Every alarm recipient parameter's name starts with this. Any change to a
 * parameter under it alerts P2 (OperatorAlarmRecipientChanges in the
 * observability stack, supply-checkout-6uw.23).
 */
export const alarmRecipientParameterPrefix = (envName: string) => `/supply-checkout/${envName}/alarms/`;

/** The SSM parameter holding the n-th (1-based) email address or phone number. */
export function alarmContactParameter(envName: string, kind: keyof AlarmContacts, n: number): string {
  return `${alarmRecipientParameterPrefix(envName)}${kind}-${n}`;
}

interface ContextReader {
  tryGetContext(key: string): unknown;
}

/** Reads `alarmContacts` from CDK context, e.g. -c alarmContacts='{"email":2,"sms":2}'. */
export function alarmContactsFromContext(node: ContextReader): AlarmContacts {
  const raw = node.tryGetContext("alarmContacts");
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (value === undefined) return DEFAULT_ALARM_CONTACTS;
  const contacts = { ...DEFAULT_ALARM_CONTACTS, ...(value as Partial<AlarmContacts>) };
  for (const kind of ["email", "sms"] as const) {
    const n = contacts[kind];
    if (!Number.isInteger(n) || n < 0 || n > MAX_CONTACTS) {
      throw new Error(`alarmContacts.${kind} must be a whole number from 0 to ${MAX_CONTACTS} (got ${String(n)})`);
    }
  }
  return contacts;
}

export interface AlarmTopicsProps {
  readonly envName: string;
  readonly contacts: AlarmContacts;
}

/**
 * The SNS topics alarms notify, one per severity, in this region (an alarm
 * can only notify a topic in its own region). P1 goes to email and SMS, P2 to
 * email. Both topics are encrypted with a key CloudWatch may use, let this
 * account's alarms publish to them, and refuse non-TLS publishing.
 */
export class AlarmTopics extends Construct {
  readonly topics: Record<Severity, Topic>;
  readonly key: Key;

  constructor(scope: Construct, id: string, props: AlarmTopicsProps) {
    super(scope, id);

    this.key = new Key(this, "Key", {
      description: `Encrypts the Supply Checkout ${props.envName} alarm topics`,
      enableKeyRotation: true,
      // The stack is stateless; nothing is lost if the key goes with it.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // CloudWatch publishes alarm notifications to the encrypted topics.
    this.key.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
    );

    const topic = (severity: Severity) =>
      new Topic(this, severity, {
        topicName: `supply-checkout-${props.envName}-alarms-${severity.toLowerCase()}`,
        displayName: `Supply Checkout ${severity}`,
        masterKey: this.key,
        enforceSSL: true,
      });
    this.topics = { P1: topic("P1"), P2: topic("P2") };
    // Without this, alarm actions fail with "CloudWatch Alarms is not
    // authorized to perform: SNS:Publish". Only this account's alarms in this
    // region may publish (confused deputy prevention).
    for (const t of Object.values(this.topics)) {
      t.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowCloudWatchAlarmsToPublish",
          principals: [new ServicePrincipal("cloudwatch.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [t.topicArn],
          conditions: {
            StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
            ArnLike: { "aws:SourceArn": `arn:${Aws.PARTITION}:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:*` },
          },
        }),
      );
    }

    const subscribe = (severity: Severity, kind: keyof AlarmContacts, protocol: SubscriptionProtocol) => {
      for (let n = 1; n <= props.contacts[kind]; n++) {
        new Subscription(this, `${severity}-${kind}-${n}`, {
          topic: this.topics[severity],
          protocol,
          // A CloudFormation parameter of type AWS::SSM::Parameter::Value<String>:
          // resolved at deploy time, so the value never appears in the template.
          endpoint: StringParameter.valueForStringParameter(this, alarmContactParameter(props.envName, kind, n)),
        });
      }
    };
    subscribe("P1", "email", SubscriptionProtocol.EMAIL);
    subscribe("P1", "sms", SubscriptionProtocol.SMS);
    subscribe("P2", "email", SubscriptionProtocol.EMAIL);
  }

  /** Notifies the severity's topic when the alarm fires only: for alarms that are notifications, where recovery is noise. */
  notifyOnAlarm(alarm: AlarmBase, severity: Severity): void {
    alarm.addAlarmAction(new SnsAction(this.topics[severity]));
  }

  /** Notifies the severity's topic when the alarm fires and when it recovers. */
  notify(alarm: AlarmBase, severity: Severity): void {
    const action: IAlarmAction = new SnsAction(this.topics[severity]);
    alarm.addAlarmAction(action);
    alarm.addOkAction(action);
  }
}
