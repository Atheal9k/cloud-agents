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

export const SharedBrowserGrant = Schema.Struct({
  viewerId: SharedBrowserViewerId,
  bootstrapPath: TrimmedNonEmptyString,
  attemptKey: TrimmedNonEmptyString,
  transport: Schema.Literal("dcv"),
  expiresAt: IsoDateTime,
});
export type SharedBrowserGrant = typeof SharedBrowserGrant.Type;

export const SharedBrowserReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type SharedBrowserReleaseResult = typeof SharedBrowserReleaseResult.Type;

export class SharedBrowserError extends Schema.TaggedError<SharedBrowserError>()(
  "SharedBrowserError",
  {
    reason: Schema.Literals(["unavailable", "wrong-thread", "lifecycle-failed", "viewer-expired"]),
    message: TrimmedNonEmptyString,
  },
) {}
