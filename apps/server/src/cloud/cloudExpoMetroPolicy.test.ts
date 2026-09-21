import { RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  classifyCloudExpoChanges,
  cloudExpoCommand,
  cloudExpoLastClientConnectionAt,
  cloudExpoMetroSessionId,
  cloudExpoProcessFailure,
  detectCloudExpoPackageManager,
} from "./cloudExpoMetroPolicy.ts";

it("uses the repository package manager for the Expo development-client command", () => {
  expect(
    detectCloudExpoPackageManager({
      packageManager: "pnpm@10.16.1",
      files: ["package-lock.json"],
    }),
  ).toBe("pnpm");
  expect(detectCloudExpoPackageManager({ files: ["apps/mobile/yarn.lock"] })).toBe("yarn");
  expect(cloudExpoCommand("pnpm")).toBe("pnpm exec expo");
  expect(cloudExpoCommand("npm")).toBe("npx expo");
});

it("keeps JavaScript, TypeScript, and asset changes on the Fast Refresh path", () => {
  expect(
    classifyCloudExpoChanges([
      "apps/mobile/src/App.tsx",
      "apps/mobile/src/theme.ts",
      "apps/mobile/assets/icon.png",
    ]),
  ).toEqual({
    status: "compatible",
    fastRefreshPaths: [
      "apps/mobile/assets/icon.png",
      "apps/mobile/src/App.tsx",
      "apps/mobile/src/theme.ts",
    ],
    detail:
      "JavaScript, TypeScript, and asset changes use Fast Refresh in the installed development build.",
  });
});

it("requires a new development build for native dependencies and configuration", () => {
  const compatibility = classifyCloudExpoChanges([
    "apps/mobile/app.config.ts",
    "apps/mobile/android/app/build.gradle",
    "apps/mobile/android/app/src/main/MainActivity.kt",
    "apps/mobile/package.json",
    "apps/mobile/src/App.tsx",
  ]);

  expect(compatibility.status).toBe("rebuild-required");
  if (compatibility.status !== "rebuild-required") return;
  expect(compatibility.nativePaths).toEqual([
    "apps/mobile/android/app/build.gradle",
    "apps/mobile/android/app/src/main/MainActivity.kt",
    "apps/mobile/app.config.ts",
    "apps/mobile/package.json",
  ]);
  expect(compatibility.fastRefreshPaths).toEqual(["apps/mobile/src/App.tsx"]);
});

it("reports phone reconnections from timestamped Metro output", () => {
  expect(
    cloudExpoLastClientConnectionAt(
      [
        "[2026-09-21T04:00:00.000Z] Waiting on exp+demo://expo-development-client/",
        "[2026-09-21T04:01:02.000Z] Android Bundled 315ms index.ts",
      ].join("\n"),
    ),
  ).toBe("2026-09-21T04:01:02.000Z");
});

it("makes process sessions allocation-attempt scoped so wake cannot reuse a stale link", () => {
  const allocation = {
    id: RunAllocationId.make("allocation/expo demo"),
    attempt: RunAllocationAttempt.make(1),
  };
  expect(cloudExpoMetroSessionId(allocation)).toBe("t3-allocation-expo-demo-1-expo-metro");
  expect(cloudExpoMetroSessionId({ ...allocation, attempt: RunAllocationAttempt.make(2) })).toBe(
    "t3-allocation-expo-demo-2-expo-metro",
  );
});

it("separates retryable port and ngrok tunnel failures", () => {
  expect(
    cloudExpoProcessFailure("Error: listen EADDRINUSE: address already in use :::8081"),
  ).toEqual({
    kind: "port-conflict",
    reason: "Port 8081 is already in use inside the Daytona sandbox.",
    retryable: true,
  });
  expect(cloudExpoProcessFailure("CommandError: ngrok tunnel took too long to connect.")).toEqual({
    kind: "tunnel",
    reason: "Expo could not establish the ngrok tunnel.",
    retryable: true,
  });
});
