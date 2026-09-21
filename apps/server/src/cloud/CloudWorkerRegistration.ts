import {
  AuthOrchestrationReadScope,
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  RunAllocationAttempt,
  RunAllocationId,
  RunAllocationCommand,
  type RunAllocation,
  type RunWorkerRegistrationInput,
  type RunWorkerRoute,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";

const SIGNING_SECRET_NAME = "cloud-worker-registration-signing-key";

const RegistrationClaims = Schema.Struct({
  version: Schema.Literal(1),
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  expiresAt: Schema.Finite,
});
type RegistrationClaims = typeof RegistrationClaims.Type;

const RegistrationClaimsJson = Schema.fromJsonString(RegistrationClaims);
const decodeRegistrationClaims = Schema.decodeUnknownOption(RegistrationClaimsJson);
const encodeRegistrationClaims = Schema.encodeSync(RegistrationClaimsJson);
const decodeCommand = Schema.decodeUnknownEffect(RunAllocationCommand);

export class CloudWorkerRegistrationError extends Schema.TaggedError<CloudWorkerRegistrationError>()(
  "CloudWorkerRegistrationError",
  {
    reason: Schema.Literals([
      "credential-invalid",
      "credential-expired",
      "attempt-obsolete",
      "allocation-not-registering",
      "route-invalid",
      "route-unavailable",
      "environment-mismatch",
      "persistence-failed",
    ]),
    message: Schema.String,
  },
) {}

export class CloudWorkerRegistration extends Context.Service<
  CloudWorkerRegistration,
  {
    readonly issueCredential: (
      allocation: RunAllocation,
    ) => Effect.Effect<string, CloudWorkerRegistrationError>;
    readonly register: (
      credential: string,
      input: RunWorkerRegistrationInput,
    ) => Effect.Effect<RunAllocation, CloudWorkerRegistrationError>;
  }
>()("t3/cloud/CloudWorkerRegistration") {}

function registrationError(
  reason: CloudWorkerRegistrationError["reason"],
  message: string,
): CloudWorkerRegistrationError {
  return new CloudWorkerRegistrationError({ reason, message });
}

function decodeClaims(encodedPayload: string): RegistrationClaims | null {
  try {
    return Option.getOrNull(decodeRegistrationClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized.startsWith("127.")
  );
}

export function normalizeWorkerRoute(route: RunWorkerRoute): RunWorkerRoute | null {
  try {
    const http = new URL(route.httpBaseUrl);
    const ws = new URL(route.wsBaseUrl);
    if (
      http.protocol !== "https:" ||
      ws.protocol !== "wss:" ||
      http.username !== "" ||
      http.password !== "" ||
      ws.username !== "" ||
      ws.password !== "" ||
      isLoopbackHostname(http.hostname) ||
      isLoopbackHostname(ws.hostname) ||
      http.host !== ws.host
    ) {
      return null;
    }
    http.pathname = "/";
    http.hash = "";
    ws.pathname = "/";
    ws.hash = "";
    return {
      httpBaseUrl: http.toString(),
      wsBaseUrl: ws.toString(),
      accessToken: route.accessToken,
    };
  } catch {
    return null;
  }
}

function environmentUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.hash = "";
  return url.toString();
}

function registrationMatches(
  allocation: RunAllocation,
  input: RunWorkerRegistrationInput,
): boolean {
  if (allocation.allocationState.status !== "ready") return false;
  const { references, route } = allocation.allocationState;
  return (
    route !== undefined &&
    references.workerId === input.references.workerId &&
    references.environmentId === input.references.environmentId &&
    references.threadId === input.references.threadId &&
    route.httpBaseUrl === input.route.httpBaseUrl &&
    route.wsBaseUrl === input.route.wsBaseUrl &&
    route.accessToken === input.route.accessToken
  );
}

const probeWorkerRoute = Effect.fn("CloudWorkerRegistration.probeWorkerRoute")(function* (
  route: RunWorkerRoute,
) {
  const client = yield* HttpClient.HttpClient;
  const descriptor = yield* client
    .execute(
      HttpClientRequest.get(environmentUrl(route.httpBaseUrl, "/.well-known/t3/environment")),
    )
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() =>
        registrationError("route-unavailable", "The worker route did not return a T3 descriptor."),
      ),
    );
  const session = yield* client
    .execute(
      HttpClientRequest.get(environmentUrl(route.httpBaseUrl, "/api/auth/session")).pipe(
        HttpClientRequest.bearerToken(route.accessToken),
      ),
    )
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthSessionState)),
      Effect.mapError(() =>
        registrationError(
          "route-unavailable",
          "The worker route rejected its controller-issued access token.",
        ),
      ),
    );
  if (
    session.authenticated !== true ||
    session.scopes?.includes(AuthOrchestrationReadScope) !== true
  ) {
    return yield* registrationError(
      "route-unavailable",
      "The worker route did not grant orchestration read access.",
    );
  }
  return descriptor;
});

export const make = Effect.fn("CloudWorkerRegistration.make")(function* (input?: {
  readonly probe?: (
    route: RunWorkerRoute,
  ) => Effect.Effect<ExecutionEnvironmentDescriptor, CloudWorkerRegistrationError>;
}) {
  const controller = yield* CloudAllocationController.CloudAllocationController;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const signingSecret = yield* secrets
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(
      Effect.mapError(() =>
        registrationError(
          "persistence-failed",
          "The controller could not load its worker registration key.",
        ),
      ),
    );
  const probe =
    input?.probe ??
    ((route: RunWorkerRoute) =>
      probeWorkerRoute(route).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)));

  const issueCredential: CloudWorkerRegistration["Service"]["issueCredential"] = (allocation) =>
    Effect.sync(() => {
      const encodedPayload = base64UrlEncode(
        encodeRegistrationClaims({
          version: 1,
          allocationId: allocation.id,
          attempt: allocation.attempt,
          expiresAt: Date.parse(allocation.deadlines.registerBy),
        }),
      );
      return `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
    });

  const register: CloudWorkerRegistration["Service"]["register"] = Effect.fn(
    "CloudWorkerRegistration.register",
  )(function* (credential, input) {
    const [encodedPayload, signature] = credential.split(".");
    if (
      !encodedPayload ||
      !signature ||
      !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))
    ) {
      return yield* registrationError(
        "credential-invalid",
        "The worker registration credential is invalid.",
      );
    }
    const claims = decodeClaims(encodedPayload);
    if (
      claims === null ||
      claims.allocationId !== input.allocationId ||
      claims.attempt !== input.attempt
    ) {
      return yield* registrationError(
        "credential-invalid",
        "The worker registration credential does not match this allocation attempt.",
      );
    }
    if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* registrationError(
        "credential-expired",
        "The worker registration credential has expired.",
      );
    }

    const snapshot = yield* controller.snapshot.pipe(
      Effect.mapError(() =>
        registrationError("persistence-failed", "The cloud allocation catalog is unavailable."),
      ),
    );
    const allocation = snapshot.allocations.find(
      (candidate) => candidate.id === input.allocationId,
    );
    if (allocation === undefined || allocation.attempt !== input.attempt) {
      return yield* registrationError(
        "attempt-obsolete",
        "This worker no longer belongs to the current allocation attempt.",
      );
    }
    if (allocation.cleanupState.status !== "not-requested") {
      return yield* registrationError(
        "attempt-obsolete",
        "This worker route has been revoked for cleanup.",
      );
    }
    if (allocation.allocationState.status === "ready") {
      return registrationMatches(allocation, input)
        ? allocation
        : yield* registrationError(
            "attempt-obsolete",
            "Another worker already registered for this allocation attempt.",
          );
    }
    if (allocation.allocationState.status !== "registering") {
      return yield* registrationError(
        "allocation-not-registering",
        "The allocation is not accepting a worker registration.",
      );
    }

    const route = normalizeWorkerRoute(input.route);
    if (route === null) {
      return yield* registrationError(
        "route-invalid",
        "Worker routes must use matching non-loopback HTTPS and WSS endpoints.",
      );
    }
    const descriptor = yield* probe(route);
    if (descriptor.environmentId !== input.references.environmentId) {
      return yield* registrationError(
        "environment-mismatch",
        "The worker route returned a different environment identity.",
      );
    }

    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const command = yield* decodeCommand({
      type: "allocation.worker-registered",
      commandId: `ca09:${allocation.id}:${allocation.attempt}:worker-registered`,
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt,
      references: input.references,
      route,
    }).pipe(
      Effect.mapError(() =>
        registrationError("persistence-failed", "The worker registration command was invalid."),
      ),
    );
    const registered = yield* controller
      .dispatch(command)
      .pipe(
        Effect.mapError(() =>
          registrationError("persistence-failed", "The worker registration could not be saved."),
        ),
      );
    if (!registrationMatches(registered, { ...input, route })) {
      return yield* registrationError(
        "attempt-obsolete",
        "The worker registration lost a race with a newer allocation state.",
      );
    }
    return registered;
  });

  return CloudWorkerRegistration.of({ issueCredential, register });
});

export const layer = Layer.effect(CloudWorkerRegistration, make());
