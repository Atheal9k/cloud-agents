import { describe, expect, it } from "vite-plus/test";

import {
  cloudSessionBaseRef,
  cloudSessionEditsRef,
  inspectBrowserPersistence,
} from "./CloudWorkerReopen.ts";

describe("reopened browser persistence", () => {
  it("says a browser came back logged in only when its profile is on durable storage", () => {
    expect(
      inspectBrowserPersistence({ T3_CLOUD_BROWSER_PROFILE: "/var/lib/t3-worker/chrome" }),
    ).toEqual({
      status: "persisted",
      profilePath: "/var/lib/t3-worker/chrome",
      detail:
        "The browser profile at /var/lib/t3-worker/chrome was restored with the guest disk. It holds live session cookies and stays on the guest.",
    });
  });

  it("reports a fresh browser rather than implying the logins survived", () => {
    expect(
      inspectBrowserPersistence({ CHROME_USER_DATA_DIR: "/run/user/1000/chrome" }),
    ).toMatchObject({ status: "fresh" });
    expect(inspectBrowserPersistence({ CHROME_USER_DATA_DIR: "/tmp/chrome" })).toMatchObject({
      status: "fresh",
    });
    expect(inspectBrowserPersistence({})).toMatchObject({ status: "fresh" });
    expect(inspectBrowserPersistence({ T3_CLOUD_BROWSER_PROFILE: "   " })).toMatchObject({
      status: "fresh",
    });
  });

  it("keeps each runtime attempt's session refs apart", () => {
    expect(cloudSessionBaseRef({ allocationId: "allocation-1", attempt: 2 })).toBe(
      "refs/t3/cloud-session/allocation-1/2/base",
    );
    expect(cloudSessionEditsRef({ allocationId: "allocation-1", attempt: 2 })).toBe(
      "refs/t3/cloud-session/allocation-1/2/edits",
    );
  });
});
