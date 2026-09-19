// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { expect, it } from "vite-plus/test";

import {
  githubTriggerPrompt,
  parseGithubWebhook,
  verifyGithubWebhookSignature,
} from "./cloudGithubTriggerPolicy.ts";

const reviewPayload = {
  action: "submitted",
  sender: { login: "octocat", type: "User" },
  repository: {
    full_name: "acme/app",
    html_url: "https://github.com/acme/app",
    default_branch: "main",
  },
  pull_request: {
    number: 42,
    title: "Fix checkout",
    body: "Keep the change small.",
    html_url: "https://github.com/acme/app/pull/42",
    head: { sha: "abc123", ref: "fix/checkout" },
  },
  review: {
    id: 7,
    body: "Please cover the retry path.",
    state: "changes_requested",
    html_url: "https://github.com/acme/app/pull/42#pullrequestreview-7",
  },
};

it("parses repair feedback with the exact pull request head", () => {
  const parsed = parseGithubWebhook("pull_request_review", reviewPayload);
  expect(parsed).toMatchObject({
    kind: "accepted",
    repository: "acme/app",
    actor: "octocat",
    source: {
      kind: "pull_request",
      number: 42,
      baseRevision: "abc123",
      commentId: "7",
    },
  });
  if (parsed?.kind !== "accepted") throw new Error("Expected accepted review feedback.");
  expect(
    githubTriggerPrompt({
      repository: parsed.repository,
      deliveryId: "delivery-1",
      source: parsed.source,
      task: parsed.task,
    }),
  ).toContain("Do not widen credentials or permissions");
});

it("does not run a pull request issue-comment without a head revision", () => {
  const parsed = parseGithubWebhook("issue_comment", {
    action: "created",
    sender: { login: "octocat", type: "User" },
    repository: reviewPayload.repository,
    issue: {
      number: 42,
      title: "Fix checkout",
      body: null,
      html_url: "https://github.com/acme/app/pull/42",
      pull_request: { url: "https://api.github.com/repos/acme/app/pulls/42" },
    },
    comment: {
      id: 8,
      body: "Please fix this.",
      html_url: "https://github.com/acme/app/pull/42#issuecomment-8",
    },
  });
  expect(parsed).toMatchObject({
    kind: "ignored",
    reason: "Issue-comment payloads do not identify the pull request head revision.",
  });
});

it("validates the raw request body with GitHub's sha256 signature", () => {
  const secret = Buffer.from("webhook-secret", "utf8");
  const body = JSON.stringify(reviewPayload);
  const signature = `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  expect(verifyGithubWebhookSignature({ secret, body, signature })).toBe(true);
  expect(verifyGithubWebhookSignature({ secret, body: `${body} `, signature })).toBe(false);
  expect(verifyGithubWebhookSignature({ secret, body, signature: "sha256=bad" })).toBe(false);
});
