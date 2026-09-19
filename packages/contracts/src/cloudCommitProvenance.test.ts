import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CloudCommitProvenance } from "./cloudCommitProvenance.ts";

const decode = Schema.decodeUnknownSync(CloudCommitProvenance);
const encode = Schema.encodeSync(CloudCommitProvenance);

describe("cloud commit provenance contracts", () => {
  it("records agent, run, environment, Build, base, provider, and principal without prompts", () => {
    const provenance = decode({
      agentId: "agent-1",
      runId: "run-1",
      environmentVersion: "env-1:3",
      buildId: "bld-1",
      baseCommit: "a".repeat(40),
      repository: "acme/app",
      provider: "codex",
      model: "gpt-5.6-sol",
      principal: { kind: "user", id: "alice" },
      commit: "b".repeat(40),
      signature: {
        keyId: "t3-cloud-signing-1",
        algorithm: "ssh-ed25519",
        format: "ssh",
        fingerprint: "SHA256:abcd",
        backing: "kms",
        signedAt: "2026-09-19T12:00:00.000Z",
      },
    });
    const encoded = encode(provenance) as Record<string, unknown>;
    expect(encoded.prompt).toBeUndefined();
    expect(encoded.secret).toBeUndefined();
    expect("prompt" in encoded).toBe(false);
    expect(provenance.principal.id).toBe("alice");
    expect(provenance.signature?.format).toBe("ssh");
  });
});
