import {
  CloudRunControlError,
  type CloudRunCancelInput,
  type CloudRunCancelResult,
  type CloudRunRetryInput,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudProviderExecution from "./CloudProviderExecution.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

export class CloudRunControl extends Context.Service<
  CloudRunControl,
  {
    readonly cancel: (
      input: CloudRunCancelInput,
    ) => Effect.Effect<CloudRunCancelResult, CloudRunControlError>;
    readonly retry: (
      input: CloudRunRetryInput,
    ) => Effect.Effect<RunAllocation, CloudRunControlError>;
  }
>()("t3/cloud/CloudRunControl") {}

function controlError(input: {
  readonly reason: CloudRunControlError["reason"];
  readonly message: string;
  readonly retryable: boolean;
}): CloudRunControlError {
  return new CloudRunControlError(input);
}

export const make = Effect.fn("CloudRunControl.make")(function* () {
  const allocations = yield* CloudAllocationController.CloudAllocationController;
  const executions = yield* CloudProviderExecution.CloudProviderExecution;
  const results = yield* CloudRunResults.CloudRunResults;

  const readAllocation = Effect.fn("CloudRunControl.readAllocation")(function* (
    allocationId: CloudRunCancelInput["allocationId"],
  ) {
    const snapshot = yield* allocations.snapshot.pipe(
      Effect.mapError(() =>
        controlError({
          reason: "controller-failed",
          message: "The cloud allocation catalog is unavailable.",
          retryable: true,
        }),
      ),
    );
    const allocation = snapshot.allocations.find((candidate) => candidate.id === allocationId);
    if (allocation === undefined) {
      return yield* controlError({
        reason: "allocation-not-found",
        message: `Cloud allocation '${allocationId}' does not exist.`,
        retryable: false,
      });
    }
    return allocation;
  });

  const requireAttempt = Effect.fn("CloudRunControl.requireAttempt")(function* (
    allocation: RunAllocation,
    attempt: CloudRunCancelInput["attempt"],
  ) {
    if (allocation.attempt !== attempt) {
      return yield* controlError({
        reason: "stale-attempt",
        message: `Cloud allocation '${allocation.id}' is now on attempt ${allocation.attempt}.`,
        retryable: false,
      });
    }
  });

  const dispatch = (command: Parameters<typeof allocations.dispatch>[0]) =>
    allocations.dispatch(command).pipe(
      Effect.mapError(() =>
        controlError({
          reason: "controller-failed",
          message: "The cloud allocation catalog rejected the control request.",
          retryable: true,
        }),
      ),
    );

  const cancel: CloudRunControl["Service"]["cancel"] = Effect.fn("CloudRunControl.cancel")(
    function* (request) {
      const allocation = yield* readAllocation(request.allocationId);
      yield* requireAttempt(allocation, request.attempt);
      if (
        request.capture.preparation.allocationId !== request.allocationId ||
        request.capture.preparation.attempt !== request.attempt ||
        request.capture.sourceThreadId !== request.interrupt.threadId
      ) {
        return yield* controlError({
          reason: "invalid-control-input",
          message:
            "The cancellation, worker thread, and retained-result source must name one attempt.",
          retryable: false,
        });
      }

      if (
        allocation.agentOutcome.status === "running" &&
        allocation.cleanupState.status === "not-requested"
      ) {
        yield* executions.interrupt(request.interrupt).pipe(Effect.ignore);
      }
      const retention = yield* Effect.result(results.capture(request.capture));
      const cancelled = yield* dispatch({
        type: "allocation.cancel",
        commandId: request.commandId,
        allocationId: request.allocationId,
        attempt: request.attempt,
        occurredAt: request.occurredAt,
      });

      return {
        allocation: cancelled,
        retention: Result.isSuccess(retention)
          ? { status: "retained", manifest: retention.success }
          : {
              status: "failed",
              reason: retention.failure.reason,
              message: retention.failure.message,
              retryable: retention.failure.retryable,
            },
      } satisfies CloudRunCancelResult;
    },
  );

  const retry: CloudRunControl["Service"]["retry"] = Effect.fn("CloudRunControl.retry")(
    function* (request) {
      const allocation = yield* readAllocation(request.allocationId);
      yield* requireAttempt(allocation, request.attempt);

      if (request.startPoint.type === "retained-result") {
        const status = yield* results.status(request.startPoint.resultId).pipe(
          Effect.mapError(() =>
            controlError({
              reason: "retained-result-unavailable",
              message: "The selected retained result is unavailable.",
              retryable: true,
            }),
          ),
        );
        if (status.status !== "retained") {
          return yield* controlError({
            reason: "retained-result-unavailable",
            message: "The selected retained result is not ready for retry.",
            retryable: status.status === "retaining" || status.retryable,
          });
        }
      }

      const retried = yield* dispatch({
        type: "allocation.retry",
        commandId: request.commandId,
        allocationId: request.allocationId,
        attempt: request.attempt,
        nextAttempt: request.nextAttempt,
        deadlines: request.deadlines,
        startPoint: request.startPoint,
        publication: request.publication,
        occurredAt: request.occurredAt,
      });
      if (retried.attempt !== request.nextAttempt) {
        return yield* controlError({
          reason: "retry-not-ready",
          message: "The previous attempt must finish cleanup before it can be retried.",
          retryable: true,
        });
      }
      return retried;
    },
  );

  return CloudRunControl.of({ cancel, retry });
});

export const layer = Layer.effect(CloudRunControl, make());
