import {
  AuthOrchestrationOperateScope,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { flushCloudRuntimeState } from "./CloudWorkerFlush.ts";
import * as CloudWorkerRegistration from "./CloudWorkerRegistration.ts";

function bearerCredential(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const credential = match?.[1]?.trim();
  return credential && credential.length > 0 ? credential : null;
}

function mapRegistrationError(error: CloudWorkerRegistration.CloudWorkerRegistrationError) {
  switch (error.reason) {
    case "credential-invalid":
    case "credential-expired":
      return new EnvironmentHttpUnauthorizedError({ message: error.message });
    case "attempt-obsolete":
    case "allocation-not-registering":
      return new EnvironmentHttpConflictError({ message: error.message });
    case "route-invalid":
    case "environment-mismatch":
      return new EnvironmentHttpBadRequestError({ message: error.message });
    case "route-unavailable":
      return new EnvironmentCloudEndpointUnavailableError({
        message: error.message,
        endpointRuntimeStatus: { status: "unavailable" },
      });
    case "persistence-failed":
      return new EnvironmentHttpInternalServerError({ message: error.message });
  }
}

export const cloudWorkerRegistrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cloudWorkers",
  Effect.fnUntraced(function* (handlers) {
    const registrations = yield* CloudWorkerRegistration.CloudWorkerRegistration;
    return (
      handlers
        .handle("register", ({ headers, payload }) => {
          const credential = bearerCredential(headers.authorization);
          if (credential === null) {
            return Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                message: "A worker registration bearer credential is required.",
              }),
            );
          }
          return registrations
            .register(credential, payload)
            .pipe(Effect.mapError(mapRegistrationError));
        })
        // Served by the guest for its own controller: it flushes the state the
        // conversation needs before the controller starts the idle-release timer.
        .handle(
          "flush",
          Effect.fn("environment.cloudWorkers.flush")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            return yield* flushCloudRuntimeState(args.payload).pipe(
              Effect.catchCause((cause) =>
                failEnvironmentInternal("cloud_runtime_flush_failed", cause),
              ),
            );
          }),
        )
    );
  }),
);
