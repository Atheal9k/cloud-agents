import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./SharedBrowserHost.ts";

function runner(stdout: string) {
  return Layer.succeed(ProcessRunner.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });
}

it.effect("prepares the thread-bound desktop and exports its display to provider processes", () =>
  Effect.gen(function* () {
    const originalDisplay = process.env.DISPLAY;
    const originalSession = process.env.T3CODE_SHARED_BROWSER_SESSION_ID;
    try {
      const host = yield* make({ lifecycleCommand: "/opt/t3/bin/cloud-agent-shared-browser" }).pipe(
        Effect.provide(
          runner(
            '{"upstreamUrl":"http://127.0.0.1:8090","sessionId":"t3-allocation-1-2","display":":1","attemptKey":"allocation-1:2","threadId":"thread-allocation-1-2"}',
          ),
        ),
      );
      const descriptor = yield* host.prepare(ThreadId.make("thread-allocation-1-2"));
      expect(descriptor.upstreamUrl).toBe("http://127.0.0.1:8090");
      expect(process.env.DISPLAY).toBe(":1");
      expect(process.env.T3CODE_SHARED_BROWSER_SESSION_ID).toBe("t3-allocation-1-2");
    } finally {
      process.env.DISPLAY = originalDisplay;
      process.env.T3CODE_SHARED_BROWSER_SESSION_ID = originalSession;
    }
  }),
);

it.effect("rejects descriptors that can route the gateway off the worker", () =>
  Effect.gen(function* () {
    const host = yield* make({ lifecycleCommand: "shared-browser" }).pipe(
      Effect.provide(
        runner(
          '{"upstreamUrl":"https://metadata.internal","sessionId":"session-1","display":":1","attemptKey":"allocation-1:2","threadId":"thread-allocation-1-2"}',
        ),
      ),
    );
    const error = yield* Effect.flip(host.prepare(ThreadId.make("thread-allocation-1-2")));
    expect(error.reason).toBe("lifecycle-failed");
  }),
);
