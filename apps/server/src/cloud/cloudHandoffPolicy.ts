import type {
  CloudHandoffChangeKind,
  CloudHandoffExcludeReason,
  CloudHandoffFile,
  CloudHandoffHistoryTransfer,
  CloudHandoffIntent,
} from "@t3tools/contracts";

const CREDENTIAL_PATH_PATTERN =
  /(^|\/)(\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|ed25519|dsa|ecdsa)(?:\.pub)?|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$|(^|\/)\.aws\/credentials$|\.(?:pem|key|p12|pfx)$/i;

export interface TransferCandidate {
  readonly path: string;
  readonly change: CloudHandoffChangeKind;
  readonly gitIgnored: boolean;
}

export function isCredentialPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return CREDENTIAL_PATH_PATTERN.test(normalized);
}

export function classifyTransferFile(candidate: TransferCandidate): CloudHandoffFile {
  if (isCredentialPath(candidate.path)) {
    return {
      path: candidate.path,
      change: candidate.change,
      inclusion: "excluded",
      excludeReason: "credential",
    };
  }
  if (candidate.gitIgnored || candidate.change === "ignored") {
    return {
      path: candidate.path,
      change: candidate.change === "ignored" ? "ignored" : candidate.change,
      inclusion: "excluded",
      excludeReason: "gitignored",
    };
  }
  return {
    path: candidate.path,
    change: candidate.change,
    inclusion: "selected",
  };
}

export function selectTransferFiles(
  files: ReadonlyArray<CloudHandoffFile>,
  selectedPaths: ReadonlyArray<string>,
): {
  readonly selected: ReadonlyArray<CloudHandoffFile>;
  readonly excluded: ReadonlyArray<CloudHandoffFile>;
} {
  const requested = new Set(selectedPaths);
  const selected: CloudHandoffFile[] = [];
  const excluded: CloudHandoffFile[] = [];
  for (const file of files) {
    if (file.excludeReason === "credential") {
      excluded.push(file);
      continue;
    }
    const includeIgnored = file.excludeReason === "gitignored" && requested.has(file.path);
    if (includeIgnored) {
      selected.push({ path: file.path, change: file.change, inclusion: "selected" });
      continue;
    }
    if (file.inclusion === "selected" && (requested.size === 0 || requested.has(file.path))) {
      selected.push(file);
      continue;
    }
    const excludeReason: CloudHandoffExcludeReason =
      file.excludeReason === "gitignored" ? "gitignored" : "not-selected";
    excluded.push({
      path: file.path,
      change: file.change,
      inclusion: "excluded",
      excludeReason,
    });
  }
  return { selected, excluded };
}

export function detectImportConflicts(input: {
  readonly dirtyLocalPaths: ReadonlyArray<string>;
  readonly incomingPaths: ReadonlyArray<string>;
}): ReadonlyArray<{ readonly path: string; readonly reason: string }> {
  const dirty = new Set(input.dirtyLocalPaths);
  return input.incomingPaths
    .filter((path) => dirty.has(path))
    .map((path) => ({
      path,
      reason: "The local file has uncommitted changes.",
    }));
}

export function retryDecision(input: {
  readonly existingFingerprint: string | undefined;
  readonly incomingFingerprint: string;
  readonly existingStatus: "applying" | "applied" | undefined;
}): "apply" | "already-applied" | "resume" {
  if (input.existingStatus === "applied") {
    return "already-applied";
  }
  if (
    input.existingStatus === "applying" &&
    input.existingFingerprint === input.incomingFingerprint
  ) {
    return "resume";
  }
  return "apply";
}

export function handoffExplanation(intent: CloudHandoffIntent): string {
  if (intent === "wake-same-agent") {
    return "Wake continues this cloud agent on its snapshot. It does not copy files into a second writer.";
  }
  return "A linked continuation copies selected files into a new environment identity. It does not attach a second writer to the source snapshot.";
}

export function historyTransfer(input: {
  readonly transcriptAvailable: boolean;
}): CloudHandoffHistoryTransfer {
  if (input.transcriptAvailable) {
    return {
      status: "seeded-continuation",
      description:
        "Provider sessions stay on the source runtime. The continuation is seeded from the retained transcript instead of copying credentials or live provider history.",
    };
  }
  return {
    status: "unsupported",
    description:
      "Provider history cannot be transferred for this pair. The continuation starts with a description of the source work, not a copied session.",
  };
}

export function parsePatchPaths(patch: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match === null) continue;
    const destination = match[2];
    if (destination !== undefined && destination !== "/dev/null") {
      paths.add(destination);
    }
  }
  return [...paths];
}

export function parseGitStatusLines(stdout: string): ReadonlyArray<TransferCandidate> {
  const files: TransferCandidate[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    const relativePath = rawLine
      .slice(3)
      .replace(/ -> .+$/, "")
      .trim();
    if (relativePath.length === 0 || seen.has(relativePath)) continue;
    seen.add(relativePath);
    const gitIgnored = code === "!!";
    const change: CloudHandoffChangeKind =
      code === "!!"
        ? "ignored"
        : code.includes("?")
          ? "untracked"
          : code.includes("D")
            ? "deleted"
            : code.includes("A")
              ? "added"
              : "modified";
    files.push({ path: relativePath, change, gitIgnored });
  }
  return files;
}
