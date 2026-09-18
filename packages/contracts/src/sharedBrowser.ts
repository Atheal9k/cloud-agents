import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SharedBrowserViewerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type SharedBrowserViewerId = typeof SharedBrowserViewerId.Type;

export const SharedBrowserIssueInput = Schema.Struct({
  threadId: ThreadId,
});
export type SharedBrowserIssueInput = typeof SharedBrowserIssueInput.Type;

export const SharedBrowserViewerInput = Schema.Struct({
  threadId: ThreadId,
  viewerId: SharedBrowserViewerId,
});
export type SharedBrowserViewerInput = typeof SharedBrowserViewerInput.Type;

export const SharedBrowserControlState = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("agent"),
  }),
  Schema.Struct({
    owner: Schema.Literal("human"),
    viewerId: SharedBrowserViewerId,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    owner: Schema.Literal("none"),
    reason: Schema.Literals(["viewer-disconnected", "viewer-expired", "handoff-failed"]),
  }),
]);
export type SharedBrowserControlState = typeof SharedBrowserControlState.Type;

export const SharedBrowserGrant = Schema.Struct({
  viewerId: SharedBrowserViewerId,
  bootstrapPath: TrimmedNonEmptyString,
  attemptKey: TrimmedNonEmptyString,
  transport: Schema.Literal("dcv"),
  expiresAt: IsoDateTime,
  control: SharedBrowserControlState,
});
export type SharedBrowserGrant = typeof SharedBrowserGrant.Type;

export const SharedBrowserReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type SharedBrowserReleaseResult = typeof SharedBrowserReleaseResult.Type;

export class SharedBrowserError extends Schema.TaggedError<SharedBrowserError>()(
  "SharedBrowserError",
  {
    reason: Schema.Literals([
      "unavailable",
      "wrong-thread",
      "lifecycle-failed",
      "viewer-expired",
      "control-busy",
      "control-not-owned",
      "handoff-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
