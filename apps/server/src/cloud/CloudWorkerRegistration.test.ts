import {
  ExecutionEnvironmentDescriptor,
  type RunAllocation,
  RunAllocationCommand,
  RunWorkerRegistrationInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudWorkerRegistration from "./CloudWorkerRegistration.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const decodeRegistration = Schema.decodeSync(RunWorkerRegistrationInput);
const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: "environment-1",
  label: "Cloud worker",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.42",
  capabilities: { repositoryIdentity: true },
});

const secrets = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.die("unused"),
  set: () => Effect.die("unused"),
  create: () => Effect.die("unused"),
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  remove: () => Effect.die("unused"),
});
const unusedHttpClient = HttpClient.make(() => Effect.die("unused"));

function firstAllocation(snapshot: {
  readonly allocations: ReadonlyArray<RunAllocation>;
}): RunAllocation {
  const allocation = snapshot.allocations[0];
  if (allocation === undefined) throw new Error("Expected one allocation");
  return allocation;
}

function command(type: string, sequence: number, extra: Record<string, unknown> = {}) {
  return decodeCommand({
    type,
    commandId: `command-${sequence}`,
    allocationId: "allocation-1",
    attempt: 1,
    occurredAt: `2026-09-17T03:00:0${sequence}.000Z`,
    ...extra,
  });
}

const registration = decodeRegistration({
  allocationId: "allocation-1",
  attempt: 1,
  references: {
    workerId: "worker-1",
    environmentId: "environment-1",
    threadId: "thread-1",
  },
  route: {
    httpBaseUrl: "https://worker.example.test/",
    wsBaseUrl: "wss://worker.example.test/",
    accessToken: "worker-access-token",
  },
});

function fixture(
  input: {
    readonly liveProbe?: boolean;
    readonly httpClient?: HttpClient.HttpClient;
  } = {},
) {
  return Effect.gen(function* () {
    const controller = yield* CloudAllocationController.make({ enabled: true });
    yield* controller.dispatch(
      command("allocation.launch", 0, {
        target: {
          repository: "t3tools/t3code",
          baseCommit: "afd7667ed",
          branch: "ca-09-route-worker-traffic",
        },
        profile: { id: "linux-web", os: "linux", arch: "x64" },
        deadlines: {
          launchBy: "2026-09-17T03:05:00.000Z",
          bootBy: "2026-09-17T03:10:00.000Z",
          registerBy: "2026-09-17T03:15:00.000Z",
          expiresAt: "2026-09-17T05:00:00.000Z",
          cleanupBy: "2026-09-17T05:05:00.000Z",
        },
      }),
    );
    yield* controller.dispatch(
      command("allocation.launch-started", 1, {
        launchTemplate: { id: "lt-worker", version: 7 },
      }),
    );
    yield* controller.dispatch(
      command("allocation.instance-launched", 2, { instanceId: "i-worker" }),
    );
    yield* controller.dispatch(command("allocation.worker-booted", 3));
    const registrations = yield* CloudWorkerRegistration.make(
      input.liveProbe === true ? undefined : { probe: () => Effect.succeed(descriptor) },
    ).pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(HttpClient.HttpClient, input.httpClient ?? unusedHttpClient),
    );
    return { controller, registrations };
  });
}

it.effect("registers a verified route and makes duplicate registration idempotent", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:04:00.000Z"));
    const { controller, registrations } = yield* fixture();
    const current = firstAllocation(yield* controller.snapshot);
    const credential = yield* registrations.issueCredential(current);
    const allocation = yield* registrations.register(credential, registration);
    const duplicate = yield* registrations.register(credential, registration);
    expect(allocation.allocationState).toMatchObject({
      status: "ready",
      route: { httpBaseUrl: "https://worker.example.test/" },
    });
    expect(duplicate).toEqual(allocation);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("probes the advertised T3 descriptor and bearer session before accepting the route", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:04:00.000Z"));
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      const body = request.url.endsWith("/.well-known/t3/environment")
        ? descriptor
        : {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session_worker",
            },
            scopes: ["orchestration:read"],
            sessionMethod: "bearer-access-token",
          };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const { controller, registrations } = yield* fixture({ liveProbe: true, httpClient });
    const credential = yield* registrations.issueCredential(
      firstAllocation(yield* controller.snapshot),
    );

    yield* registrations.register(credential, registration);

    expect(requests).toEqual([
      { url: "https://worker.example.test/.well-known/t3/environment" },
      {
        url: "https://worker.example.test/api/auth/session",
        authorization: "Bearer worker-access-token",
      },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects loopback routes before probing them", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:04:00.000Z"));
    const { controller, registrations } = yield* fixture();
    const allocation = firstAllocation(yield* controller.snapshot);
    const credential = yield* registrations.issueCredential(allocation);
    const error = yield* registrations
      .register(
        credential,
        decodeRegistration({
          ...registration,
          route: {
            ...registration.route,
            httpBaseUrl: "https://localhost:3773/",
            wsBaseUrl: "wss://localhost:3773/",
          },
        }),
      )
      .pipe(Effect.flip);
    expect(error.reason).toBe("route-invalid");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects an expired attempt credential", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:04:00.000Z"));
    const { controller, registrations } = yield* fixture();
    const credential = yield* registrations.issueCredential(
      firstAllocation(yield* controller.snapshot),
    );
    yield* TestClock.setTime(Date.parse("2026-09-17T03:15:00.000Z"));
    const error = yield* registrations.register(credential, registration).pipe(Effect.flip);
    expect(error.reason).toBe("credential-expired");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects a registered worker after cleanup revokes its attempt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:04:00.000Z"));
    const { controller, registrations } = yield* fixture();
    const credential = yield* registrations.issueCredential(
      firstAllocation(yield* controller.snapshot),
    );
    yield* registrations.register(credential, registration);
    yield* controller.dispatch(command("allocation.cancel", 4));

    const error = yield* registrations.register(credential, registration).pipe(Effect.flip);

    expect(error.reason).toBe("attempt-obsolete");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
