import { describe, expect, it } from "vite-plus/test";

import {
  classifyTransferFile,
  detectImportConflicts,
  handoffExplanation,
  historyTransfer,
  isCredentialPath,
  parseGitStatusLines,
  parsePatchPaths,
  retryDecision,
  selectTransferFiles,
} from "./cloudHandoffPolicy.ts";

describe("cloudHandoffPolicy", () => {
  it("never treats credential files as implicitly selected", () => {
    expect(isCredentialPath(".env")).toBe(true);
    expect(isCredentialPath("config/.env.local")).toBe(true);
    expect(isCredentialPath(".aws/credentials")).toBe(true);
    expect(isCredentialPath("certs/prod.pem")).toBe(true);
    expect(isCredentialPath("src/app.ts")).toBe(false);
    expect(
      classifyTransferFile({ path: ".env", change: "modified", gitIgnored: false }).inclusion,
    ).toBe("excluded");
  });

  it("keeps gitignored files excluded unless they are named explicitly", () => {
    const files = [
      classifyTransferFile({ path: "src/app.ts", change: "modified", gitIgnored: false }),
      classifyTransferFile({ path: "tmp.log", change: "untracked", gitIgnored: true }),
      classifyTransferFile({ path: ".env", change: "modified", gitIgnored: true }),
    ];
    const implicit = selectTransferFiles(files, []);
    expect(implicit.selected.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(implicit.excluded.map((file) => file.path)).toEqual(["tmp.log", ".env"]);

    const explicitIgnored = selectTransferFiles(files, ["tmp.log", ".env"]);
    expect(explicitIgnored.selected.map((file) => file.path)).toEqual(["tmp.log"]);
    expect(explicitIgnored.excluded.map((file) => file.path)).toEqual(["src/app.ts", ".env"]);
  });

  it("reports overlapping dirty local files as import conflicts", () => {
    expect(
      detectImportConflicts({
        dirtyLocalPaths: ["src/app.ts", "README.md"],
        incomingPaths: ["src/app.ts", "src/new.ts"],
      }),
    ).toEqual([{ path: "src/app.ts", reason: "The local file has uncommitted changes." }]);
  });

  it("retries an identical patch without applying it twice", () => {
    expect(
      retryDecision({
        existingFingerprint: "abc",
        incomingFingerprint: "abc",
        existingStatus: "applied",
      }),
    ).toBe("already-applied");
    expect(
      retryDecision({
        existingFingerprint: "abc",
        incomingFingerprint: "abc",
        existingStatus: "applying",
      }),
    ).toBe("resume");
    expect(
      retryDecision({
        existingFingerprint: "old",
        incomingFingerprint: "abc",
        existingStatus: "applied",
      }),
    ).toBe("already-applied");
  });

  it("distinguishes wake from a linked continuation", () => {
    expect(handoffExplanation("wake-same-agent")).toContain("this cloud agent");
    expect(handoffExplanation("linked-continuation")).toContain("new environment identity");
  });

  it("seeds a continuation when provider history cannot move", () => {
    expect(historyTransfer({ transcriptAvailable: true }).status).toBe("seeded-continuation");
    expect(historyTransfer({ transcriptAvailable: false }).status).toBe("unsupported");
  });

  it("parses git status and patch paths", () => {
    expect(parseGitStatusLines(" M src/app.ts\n?? notes.txt\n!! .env\n")).toEqual([
      { path: "src/app.ts", change: "modified", gitIgnored: false },
      { path: "notes.txt", change: "untracked", gitIgnored: false },
      { path: ".env", change: "ignored", gitIgnored: true },
    ]);
    expect(
      parsePatchPaths(
        "diff --git a/src/app.ts b/src/app.ts\nindex 1..2\ndiff --git a/old b/src/new.ts\n",
      ),
    ).toEqual(["src/app.ts", "src/new.ts"]);
  });
});
