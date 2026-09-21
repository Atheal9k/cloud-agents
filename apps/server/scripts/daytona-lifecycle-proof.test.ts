import { assert, describe, it } from "@effect/vitest";

import { loadProofConfig, redactEvidence, splitCommand } from "./daytona-lifecycle-proof.ts";

describe("daytona lifecycle proof", () => {
  it("accepts the sandbox API key name without copying it into other config", () => {
    const config = loadProofConfig({ DAYTONA_SANDBOX_API_KEY: "secret-key" });

    assert.equal(config.apiKey, "secret-key");
    assert.equal(config.apiUrl, "https://app.daytona.io/api");
    assert.equal(config.resources, undefined);
  });

  it("prefers the dedicated development key", () => {
    const config = loadProofConfig({
      DAYTONA_DEV_API_KEY: "development-key",
      DAYTONA_API_KEY: "organization-key",
      DAYTONA_SANDBOX_API_KEY: "sandbox-key",
    });

    assert.equal(config.apiKey, "development-key");
  });

  it("rejects missing credentials before a sandbox can be created", () => {
    assert.throws(() => loadProofConfig({}), /DAYTONA_SANDBOX_API_KEY/);
  });

  it("parses quoted SSH commands without invoking a shell", () => {
    assert.deepEqual(splitCommand('ssh -o "ProxyCommand=connect --token abc" user@example.com'), [
      "ssh",
      "-o",
      "ProxyCommand=connect --token abc",
      "user@example.com",
    ]);
  });

  it("redacts credentials, signed URLs, and query tokens", () => {
    const evidence = redactEvidence(
      {
        apiKey: "top-secret",
        preview: "https://preview.test/path?token=signed-secret&port=3000",
      },
      ["top-secret", "signed-secret"],
    );

    assert.equal(/top-secret|signed-secret/.test(evidence), false);
    assert.equal(/\[redacted\]/.test(evidence), true);
  });
});
