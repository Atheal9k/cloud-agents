import type { CloudAgentReview, CloudAgentReviewAction } from "@t3tools/contracts";

export function cloudAgentStatusLabel(status: CloudAgentReview["agentStatus"]): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "IDLE":
      return "Idle";
    case "ARCHIVED":
      return "Archived";
  }
}

export function cloudRunStatusLabel(status: CloudAgentReview["latestRun"]["status"]): string {
  return status;
}

export function cloudSessionAvailabilityLabel(
  kind: "Preview" | "Terminal",
  availability: CloudAgentReview["previewAvailability"],
): string {
  return availability === "available" ? `${kind} available` : `${kind} unavailable`;
}

export function cloudReviewActionLabel(action: CloudAgentReviewAction): string {
  switch (action) {
    case "archive":
      return "Archive";
    case "unarchive":
      return "Unarchive";
    case "cancel":
      return "Cancel run";
    case "reopen":
      return "Reopen preview";
    case "stop":
      return "Stop session";
    case "delete":
      return "Delete permanently";
    case "delete-pr":
      return "Delete pull request";
  }
}

export function cloudDiffInspectionLabel(review: CloudAgentReview["diff"]): string {
  switch (review.status) {
    case "text":
      return review.truncated ? "Truncated text" : "Text";
    case "binary":
      return "Binary";
    case "oversized":
      return "Oversized";
    case "missing":
      return "Missing";
  }
}
