import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { previewGatewayBootstrapUrl, previewGatewayRequest } from "./previewGatewayUrl";

const threadId = ThreadId.make("thread-allocation-1-2");

describe("preview gateway URL", () => {
  it("requests a thread-bound grant for loopback apps behind a public environment route", () => {
    expect(
      previewGatewayRequest(
        "https://worker.example.test",
        threadId,
        "http://localhost:5173/dashboard?mode=test#results",
      ),
    ).toEqual({
      input: {
        threadId,
        port: 5173,
        protocol: "http",
        path: "/dashboard?mode=test",
      },
      hash: "#results",
    });
  });

  it("gateways remote private routes, but keeps local environments and public targets direct", () => {
    expect(
      previewGatewayRequest("https://100.65.0.2:3773", threadId, "http://localhost:5173"),
    ).toMatchObject({ input: { threadId, port: 5173 } });
    expect(
      previewGatewayRequest("http://100.65.0.2:3773", threadId, "http://localhost:5173"),
    ).toBeNull();
    expect(
      previewGatewayRequest("http://127.0.0.1:3773", threadId, "http://localhost:5173"),
    ).toBeNull();
    expect(
      previewGatewayRequest("https://worker.example.test", threadId, "https://example.com/app"),
    ).toBeNull();
  });

  it("builds the bootstrap on the worker origin and preserves the document fragment", () => {
    expect(
      previewGatewayBootstrapUrl(
        "https://worker.example.test/t3/",
        {
          bootstrapPath: "/api/preview-gateway/grant",
          expiresAt: "2026-09-17T06:00:00.000Z",
        },
        "#results",
      ),
    ).toBe("https://worker.example.test/api/preview-gateway/grant#results");
  });
});
