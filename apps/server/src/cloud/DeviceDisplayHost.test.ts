import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./DeviceDisplayHost.ts";

const androidDescriptor = JSON.stringify({
  upstreamUrl: "http://127.0.0.1:3401",
  attemptKey: "allocation-1:2",
  threadId: "thread-allocation-1-2",
  session: {
    platform: "android",
    transport: "serve-emu",
    deviceName: "t3-android-allocation1-2",
    runtime: "Android 36",
    serial: "emulator-5554",
    buildRevision: "debug-1",
    connectionState: "booted",
  },
});

const iosDescriptor = JSON.stringify({
  upstreamUrl: "http://127.0.0.1:3401",
  attemptKey: "allocation-1:2",
  threadId: "thread-allocation-1-2",
  session: {
    platform: "ios",
    transport: "serve-sim",
    deviceName: "t3-ios-allocation1-2",
    runtime: "iOS 18.5",
    udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    buildRevision: "debug-1",
    connectionState: "app-running",
  },
});

function runner(stdout: string, calls?: Array<{ command: string; args: ReadonlyArray<string> }>) {
  return Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        calls?.push({ command: input.command, args: input.args });
        return {
          stdout: input.args.length === 0 ? stdout : stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
}

it.effect("prepares an Android serve-emu session bound to the job serial", () =>
  Effect.gen(function* () {
    const host = yield* make({
      lifecycleCommand: "/opt/t3/bin/cloud-agent-device-display",
    }).pipe(Effect.provide(runner(androidDescriptor)));
    const descriptor = yield* host.prepare(ThreadId.make("thread-allocation-1-2"));
    expect(descriptor.session.platform).toBe("android");
    expect(descriptor.session.transport).toBe("serve-emu");
    expect(descriptor.session.serial).toBe("emulator-5554");
    expect(descriptor.upstreamUrl).toBe("http://127.0.0.1:3401");
  }),
);

it.effect("prepares an iOS serve-sim session bound to the job UDID", () =>
  Effect.gen(function* () {
    const host = yield* make({
      lifecycleCommand: "/opt/t3/bin/cloud-agent-device-display",
    }).pipe(Effect.provide(runner(iosDescriptor)));
    const descriptor = yield* host.prepare(ThreadId.make("thread-allocation-1-2"));
    expect(descriptor.session.platform).toBe("ios");
    expect(descriptor.session.transport).toBe("serve-sim");
    expect(descriptor.session.udid).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  }),
);

it.effect("rejects descriptors that can route the gateway off the worker", () =>
  Effect.gen(function* () {
    const host = yield* make({ lifecycleCommand: "device-display" }).pipe(
      Effect.provide(
        runner(
          '{"upstreamUrl":"https://metadata.internal","attemptKey":"allocation-1:2","threadId":"thread-allocation-1-2","session":{"platform":"android","transport":"serve-emu","deviceName":"phone","runtime":"Android 36","serial":"emulator-5554","buildRevision":"1","connectionState":"booted"}}',
        ),
      ),
    );
    const error = yield* Effect.flip(host.prepare(ThreadId.make("thread-allocation-1-2")));
    expect(error.reason).toBe("lifecycle-failed");
  }),
);

it.effect("clears the prepared session so reopen recreates the declared profile", () =>
  Effect.gen(function* () {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const host = yield* make({ lifecycleCommand: "device-display" }).pipe(
      Effect.provide(runner(androidDescriptor, calls)),
    );
    yield* host.prepare(ThreadId.make("thread-allocation-1-2"));
    yield* host.reset();
    const again = yield* host.prepare(ThreadId.make("thread-allocation-1-2"));
    expect(again.session.serial).toBe("emulator-5554");
    expect(calls).toEqual([
      { command: "device-display", args: ["thread-allocation-1-2"] },
      { command: "device-display", args: ["thread-allocation-1-2"] },
    ]);
  }),
);

it.effect("changes input permissions only through the configured worker helper", () =>
  Effect.gen(function* () {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const host = yield* make({
      lifecycleCommand: "device-display",
      permissionCommand: "device-display-permissions",
    }).pipe(Effect.provide(runner(androidDescriptor, calls)));
    yield* host.setInputEnabled(ThreadId.make("thread-allocation-1-2"), true);
    yield* host.setInputEnabled(ThreadId.make("thread-allocation-1-2"), false);
    expect(calls).toEqual([
      { command: "device-display", args: ["thread-allocation-1-2"] },
      { command: "device-display-permissions", args: ["human"] },
      { command: "device-display-permissions", args: ["agent"] },
    ]);
  }),
);
