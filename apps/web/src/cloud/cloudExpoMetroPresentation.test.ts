import { CloudExpoMetroSession } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  cloudExpoMetroCanRetry,
  cloudExpoMetroLabels,
  cloudExpoStartupLabel,
} from "./cloudExpoMetroPresentation.ts";

const decodeSession = Schema.decodeSync(CloudExpoMetroSession);

describe("Expo Metro presentation", () => {
  it("keeps the running Metro and failed tunnel states distinct", () => {
    const session = decodeSession({
      status: "tunnel-error",
      metro: {
        status: "running",
        startedAt: "2026-09-21T04:00:00.000Z",
        startupMs: 60_000,
      },
      tunnel: {
        status: "error",
        reason: "Expo did not establish the tunnel within 60 seconds.",
        retryable: true,
      },
      logs: "CommandError: ngrok tunnel took too long to connect.",
    });

    expect(cloudExpoMetroLabels(session)).toEqual({ metro: "Running", tunnel: "Error" });
    expect(cloudExpoMetroCanRetry(session)).toBe(true);
  });

  it("formats measured startup time without false precision", () => {
    expect(cloudExpoStartupLabel(850)).toBe("850 ms");
    expect(cloudExpoStartupLabel(1_240)).toBe("1.2 s");
  });
});
