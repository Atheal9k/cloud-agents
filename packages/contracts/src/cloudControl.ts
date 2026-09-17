import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  RunAllocation,
  RunDeadlines,
  RunPublicationReconciliation,
  RunRetryStartPoint,
} from "./cloudAllocation.ts";
import { CloudProviderInterruptInput } from "./cloudExecution.ts";
import { CloudResultCaptureInput, CloudResultManifest } from "./cloudResults.ts";

export const CloudRunCancelInput = Schema.Struct({
  commandId: CommandId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  occurredAt: IsoDateTime,
  interrupt: CloudProviderInterruptInput,
  capture: CloudResultCaptureInput,
});
export type CloudRunCancelInput = typeof CloudRunCancelInput.Type;

export const CloudRunCancelRetention = Schema.Union([
  Schema.Struct({ status: Schema.Literal("retained"), manifest: CloudResultManifest }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  }),
]);
export type CloudRunCancelRetention = typeof CloudRunCancelRetention.Type;

export const CloudRunCancelResult = Schema.Struct({
  allocation: RunAllocation,
  retention: CloudRunCancelRetention,
});
export type CloudRunCancelResult = typeof CloudRunCancelResult.Type;

export const CloudRunRetryInput = Schema.Struct({
  commandId: CommandId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  nextAttempt: RunAllocationAttempt,
  deadlines: RunDeadlines,
  startPoint: RunRetryStartPoint,
  publication: RunPublicationReconciliation,
  occurredAt: IsoDateTime,
});
export type CloudRunRetryInput = typeof CloudRunRetryInput.Type;

export class CloudRunControlError extends Schema.TaggedError<CloudRunControlError>()(
  "CloudRunControlError",
  {
    reason: Schema.Literals([
      "allocation-not-found",
      "stale-attempt",
      "invalid-control-input",
      "retained-result-unavailable",
      "retry-not-ready",
      "controller-failed",
    ]),
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  },
) {}
