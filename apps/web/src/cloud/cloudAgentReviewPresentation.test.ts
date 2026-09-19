import { describe, expect, it } from "vite-plus/test";

import {
  cloudAgentStatusLabel,
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
    expect(cloudReviewActionLabel("wake")).toBe("Wake");
    expect(cloudReviewActionLabel("delete-pr")).toBe("Delete pull request");
  });
});
