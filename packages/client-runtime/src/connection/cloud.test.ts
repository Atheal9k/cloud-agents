import { RunAllocation, emptyCloudSessionLeases } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { cloudWorkerConnectionRegistration } from "./cloud.ts";

const decodeAllocation = Schema.decodeSync(RunAllocation);

it("turns a current routed worker into the ordinary bearer connection shape", () => {
  const allocation = decodeAllocation({
    id: "allocation-1",
    attempt: 1,
    target: { repository: "t3tools/t3code", baseCommit: "abc123", branch: "ca-09" },
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: "2026-09-17T03:05:00.000Z",
      bootBy: "2026-09-17T03:10:00.000Z",
      registerBy: "2026-09-17T03:15:00.000Z",
      expiresAt: "2026-09-17T05:00:00.000Z",
      cleanupBy: "2026-09-17T05:05:00.000Z",
    },
    allocationState: {
      status: "ready",
      instanceId: "i-worker",
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
      readyAt: "2026-09-17T03:04:00.000Z",
    },
    agentOutcome: { status: "not-started" },
    previewState: { status: "unavailable" },
    leases: emptyCloudSessionLeases(),
    idleState: { status: "busy" },
    cleanupState: { status: "not-requested" },
    handledCommandIds: ["launch", "register"],
    sequence: 2,
    createdAt: "2026-09-17T03:00:00.000Z",
    updatedAt: "2026-09-17T03:04:00.000Z",
  });

  expect(cloudWorkerConnectionRegistration(allocation)).toMatchObject({
    _tag: "BearerConnectionRegistration",
    target: {
      environmentId: "environment-1",
      connectionId: "cloud:allocation-1:1",
    },
    profile: {
      httpBaseUrl: "https://worker.example.test/",
      wsBaseUrl: "wss://worker.example.test/",
    },
    credential: { token: "worker-access-token" },
  });
});

it("does not publish a connection after cleanup starts", () => {
  const allocation = decodeAllocation({
    id: "allocation-1",
    attempt: 1,
    target: { repository: "t3tools/t3code", baseCommit: "abc123", branch: "ca-09" },
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: "2026-09-17T03:05:00.000Z",
      bootBy: "2026-09-17T03:10:00.000Z",
      registerBy: "2026-09-17T03:15:00.000Z",
      expiresAt: "2026-09-17T05:00:00.000Z",
      cleanupBy: "2026-09-17T05:05:00.000Z",
    },
    allocationState: {
      status: "ready",
      instanceId: "i-worker",
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
      readyAt: "2026-09-17T03:04:00.000Z",
    },
    agentOutcome: { status: "cancelled", cancelledAt: "2026-09-17T03:05:00.000Z" },
    previewState: { status: "unavailable" },
    leases: emptyCloudSessionLeases(),
    idleState: { status: "busy" },
    cleanupState: { status: "running", startedAt: "2026-09-17T03:05:00.000Z" },
    handledCommandIds: ["launch", "register", "cancel", "cleanup"],
    sequence: 4,
    createdAt: "2026-09-17T03:00:00.000Z",
    updatedAt: "2026-09-17T03:05:00.000Z",
  });

  expect(cloudWorkerConnectionRegistration(allocation)).toBeNull();
});
