import { describe, expect, it } from "vite-plus/test";

import {
  cloudAgentStatusLabel,
  cloudProvenanceLabel,
  cloudReviewActionLabel,
  cloudSessionAvailabilityLabel,
} from "./cloudAgentReviewPresentation.ts";

describe("cloud agent review presentation", () => {
  it("keeps agent, run, and session labels distinct", () => {
    expect(cloudAgentStatusLabel("IDLE")).toBe("Idle");
    expect(cloudAgentStatusLabel("ACTIVE")).toBe("Active");
    expect(cloudAgentStatusLabel("ARCHIVED")).toBe("Archived");
    expect(cloudSessionAvailabilityLabel("Preview", "unavailable")).toBe("Preview unavailable");
    expect(cloudSessionAvailabilityLabel("Terminal", "available")).toBe("Terminal available");
    expect(cloudReviewActionLabel("reopen")).toBe("Reopen preview");
    expect(cloudReviewActionLabel("stop")).toBe("Stop session");
    expect(cloudReviewActionLabel("delete-pr")).toBe("Delete pull request");
    expect(
      cloudProvenanceLabel({
        baseCommit: "abc",
        repository: "acme/app",
        provider: "codex",
        model: "gpt-5.6-sol",
        principal: { kind: "user", id: "alice" },
        signature: {
          keyId: "k1",
          algorithm: "ssh-ed25519",
          format: "ssh",
          fingerprint: "SHA256:abcd",
          backing: "kms",
          signedAt: "2026-09-19T12:00:00.000Z",
        },
      }),
    ).toContain("SHA256:abcd");
  });
});
