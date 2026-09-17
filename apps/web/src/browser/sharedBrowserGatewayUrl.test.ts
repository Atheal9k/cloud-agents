import { describe, expect, it } from "vite-plus/test";

import { sharedBrowserGatewayUrl } from "./sharedBrowserGatewayUrl";

describe("sharedBrowserGatewayUrl", () => {
  it("keeps the viewer on the selected environment origin", () => {
    expect(
      sharedBrowserGatewayUrl(
        "https://worker.example.test/base",
        {
          viewerId: "viewer-1",
          bootstrapPath: "/api/shared-browser/token-1",
          attemptKey: "allocation-1:2",
          transport: "dcv",
          expiresAt: "2026-09-17T01:02:03.000Z",
        },
        3,
      ),
    ).toBe("https://worker.example.test/api/shared-browser/token-1?viewer=3");
  });
});
