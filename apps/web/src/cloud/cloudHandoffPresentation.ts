import type {
  CloudHandoffExcludeReason,
  CloudHandoffExecuteResult,
  CloudHandoffFile,
  CloudHandoffIntent,
  CloudHandoffPreview,
} from "@t3tools/contracts";

export function cloudHandoffIntentLabel(intent: CloudHandoffIntent): string {
  switch (intent) {
    case "wake-same-agent":
      return "Wake the same agent";
    case "linked-continuation":
      return "Create a linked continuation";
  }
}

export function cloudHandoffExcludeLabel(reason: CloudHandoffExcludeReason): string {
  switch (reason) {
    case "credential":
      return "Credential — never uploaded";
    case "gitignored":
      return "Ignored by git";
    case "not-selected":
      return "Not selected";
  }
}

export function cloudHandoffFileLabel(file: CloudHandoffFile): string {
  if (file.inclusion === "excluded" && file.excludeReason !== undefined) {
    return `${file.path} · ${cloudHandoffExcludeLabel(file.excludeReason)}`;
  }
  return `${file.path} · ${file.change}`;
}

export function cloudHandoffResultSummary(result: CloudHandoffExecuteResult): string {
  switch (result.status) {
    case "woke-same-agent":
      return "Continued the same cloud agent. No second writer was attached to the snapshot.";
    case "already-applied":
      return "This transfer was already applied. The patch was not applied again.";
    case "applied":
      return `Copied ${result.appliedPaths.length} file${result.appliedPaths.length === 1 ? "" : "s"} into ${result.destination.workspacePath ?? "the destination"}.`;
  }
}

export function cloudHandoffSelectedCount(preview: CloudHandoffPreview): number {
  return preview.files.filter((file) => file.inclusion === "selected").length;
}
