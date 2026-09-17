import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { CloudRepositoryPreparationRecord, CloudRunStageTiming } from "./cloudRepository.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeMode,
  UserInputAttachments,
} from "./orchestration.ts";

export const CLOUD_PROVIDER_MAX_UNANSWERED_REQUEST_SECONDS = 60 * 60;
export const CLOUD_PROVIDER_DEFAULT_UNANSWERED_REQUEST_SECONDS = 15 * 60;

export const CloudProviderUnansweredRequestSeconds = PositiveInt.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(CLOUD_PROVIDER_MAX_UNANSWERED_REQUEST_SECONDS)),
  Schema.brand("CloudProviderUnansweredRequestSeconds"),
);
export type CloudProviderUnansweredRequestSeconds =
  typeof CloudProviderUnansweredRequestSeconds.Type;

const defaultUnansweredRequestSeconds = CloudProviderUnansweredRequestSeconds.make(
  CLOUD_PROVIDER_DEFAULT_UNANSWERED_REQUEST_SECONDS,
);

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
  unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds,
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
  unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.pipe(
    Schema.withDecodingDefault(Effect.succeed(defaultUnansweredRequestSeconds)),
  ),
  acceptedSequence: NonNegativeInt,
  providerStartTiming: Schema.optionalKey(CloudRunStageTiming),
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

export const CloudProviderApprovalInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});
export type CloudProviderApprovalInput = typeof CloudProviderApprovalInput.Type;

export const CloudProviderUserInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  createdAt: IsoDateTime,
});
export type CloudProviderUserInput = typeof CloudProviderUserInput.Type;

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
      "invalid-execution-policy",
      "orchestration-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
