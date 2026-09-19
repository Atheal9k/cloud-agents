import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CloudSelfHostedErrorBody,
  CloudSelfHostedPendingRequest,
  admitSelfHostedTarget,
  isSelfHostedWorkerProfile,
  selfHostedLaunchPreview,
  SELF_HOSTED_WORKER_PROFILE_ID,
} from "./cloudSelfHosted.ts";

describe("self-hosted contracts", () => {
  it("decodes pool errors and pending requests, including wake fields", () => {
    expect(
      Schema.decodeSync(CloudSelfHostedErrorBody)({
        code: "cursor_expired",
        message: "Relist pending requests.",
      }).code,
    ).toBe("cursor_expired");
    expect(
      Schema.decodeSync(CloudSelfHostedPendingRequest)({
        id: "bc-1",
        userId: 321,
        createdAtMs: 1,
        labels: [{ key: "pool", value: "gpu" }],
        claimedWorkerId: "pw_1",
        wakeTimeoutMs: 900_000,
      }).wakeTimeoutMs,
    ).toBe(900_000);
  });

  it("gates launch targets and names the self-hosted worker profile", () => {
    expect(isSelfHostedWorkerProfile({ id: SELF_HOSTED_WORKER_PROFILE_ID })).toBe(true);
    expect(admitSelfHostedTarget({ policy: "off", target: "pool" })?.code).toBe("self_hosted_disabled");
    expect(selfHostedLaunchPreview({ policy: "allow", target: "machine" }).differences).toHaveLength(5);
  });
});
