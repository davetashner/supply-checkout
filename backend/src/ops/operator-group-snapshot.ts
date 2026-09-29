// The operator group watch's snapshot in its SSM parameter. A parameter with
// no value reads as "", which the watch can't parse, so it counts as a reset.

import { GetParameterCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

export function snapshotStore(ssm: Pick<SSMClient, "send">, name: string) {
  return {
    read: async (): Promise<string> => {
      const answer = await ssm.send(new GetParameterCommand({ Name: name }));
      return answer?.Parameter?.Value ?? "";
    },
    write: async (snapshot: string): Promise<void> => {
      await ssm.send(new PutParameterCommand({ Name: name, Value: snapshot, Type: "String", Overwrite: true }));
    },
  };
}
