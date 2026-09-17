import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { CloudRepositoryPreparationRecord } from "./cloudRepository.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const CloudProviderTurnInput = Schema.Struct({
  commandId: CommandId,
  messageId: MessageId,
  prompt: TrimmedNonEmptyString,
  attachments: Schema.Array(ChatAttachment).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});
export type CloudProviderTurnInput = typeof CloudProviderTurnInput.Type;

export const CloudProviderExecutionStartInput = Schema.Struct({
  preparation: CloudRepositoryPreparationRecord,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  turn: CloudProviderTurnInput,
});
export type CloudProviderExecutionStartInput = typeof CloudProviderExecutionStartInput.Type;

export const CloudProviderExecutionRecord = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  projectId: ProjectId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  acceptedSequence: NonNegativeInt,
  startedAt: IsoDateTime,
});
export type CloudProviderExecutionRecord = typeof CloudProviderExecutionRecord.Type;

export const CloudProviderFollowUpInput = Schema.Struct({
  threadId: ThreadId,
  turn: CloudProviderTurnInput,
});
export type CloudProviderFollowUpInput = typeof CloudProviderFollowUpInput.Type;

export const CloudProviderInterruptInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});
export type CloudProviderInterruptInput = typeof CloudProviderInterruptInput.Type;

export class CloudProviderExecutionError extends Schema.TaggedError<CloudProviderExecutionError>()(
  "CloudProviderExecutionError",
  {
    reason: Schema.Literals([
      "provider-not-qualified",
      "provider-unavailable",
      "authentication-failed",
      "model-unavailable",
      "quota-exhausted",
      "unsupported-attachment",
      "orchestration-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
