import type {
  CloudExpoDevelopmentBuildCompatibility,
  CloudExpoPackageManager,
  RunAllocation,
} from "@t3tools/contracts";

export const CLOUD_EXPO_METRO_PORT = 8081;
export const CLOUD_EXPO_TUNNEL_TIMEOUT_MS = 60_000;
export const CLOUD_EXPO_LOG_LIMIT = 64 * 1024;

const FAST_REFRESH_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".flac",
  ".gif",
  ".heic",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".png",
  ".svg",
  ".ts",
  ".tsx",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
]);

const PACKAGE_MANAGER_LOCKS: ReadonlyArray<readonly [string, CloudExpoPackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function extension(path: string): string {
  const normalized = normalizedPath(path).toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index === -1 ? "" : normalized.slice(index);
}

function isNativePath(path: string): boolean {
  const normalized = normalizedPath(path).toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return (
    normalized.startsWith("android/") ||
    normalized.includes("/android/") ||
    normalized.startsWith("ios/") ||
    normalized.includes("/ios/") ||
    normalized.startsWith("plugins/") ||
    normalized.includes("/plugins/") ||
    normalized.startsWith("patches/") ||
    normalized.includes("/patches/") ||
    name === "app.json" ||
    name === "app.config.js" ||
    name === "app.config.cjs" ||
    name === "app.config.mjs" ||
    name === "app.config.ts" ||
    name === "eas.json" ||
    name === "podfile" ||
    name === "podfile.lock" ||
    name === "build.gradle" ||
    name === "build.gradle.kts" ||
    name === "settings.gradle" ||
    name === "settings.gradle.kts" ||
    name === "gradle.properties" ||
    name === "package.json" ||
    name === "package-lock.json" ||
    name === "npm-shrinkwrap.json" ||
    name === "pnpm-lock.yaml" ||
    name === "yarn.lock" ||
    name === "bun.lock" ||
    name === "bun.lockb" ||
    normalized.endsWith(".java") ||
    normalized.endsWith(".kt") ||
    normalized.endsWith(".kts") ||
    normalized.endsWith(".swift") ||
    normalized.endsWith(".m") ||
    normalized.endsWith(".mm") ||
    normalized.endsWith(".h")
  );
}

export function classifyCloudExpoChanges(
  paths: ReadonlyArray<string>,
): CloudExpoDevelopmentBuildCompatibility {
  const normalized = [
    ...new Set(paths.map(normalizedPath).filter((path) => path.length > 0)),
  ].sort();
  const nativePaths = normalized.filter(isNativePath);
  const fastRefreshPaths = normalized.filter(
    (path) => !isNativePath(path) && FAST_REFRESH_EXTENSIONS.has(extension(path)),
  );
  if (nativePaths.length > 0) {
    return {
      status: "rebuild-required",
      nativePaths,
      fastRefreshPaths,
      detail:
        "Native dependencies or app configuration changed. Install a new development build before reconnecting.",
    };
  }
  return {
    status: "compatible",
    fastRefreshPaths,
    detail:
      fastRefreshPaths.length === 0
        ? "No native changes were detected. The installed development build can use this Metro session."
        : "JavaScript, TypeScript, and asset changes use Fast Refresh in the installed development build.",
  };
}

export function detectCloudExpoPackageManager(input: {
  readonly packageManager?: string | undefined;
  readonly files: ReadonlyArray<string>;
}): CloudExpoPackageManager {
  const declared = input.packageManager?.split("@")[0]?.trim().toLowerCase();
  switch (declared) {
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return declared;
  }
  const names = new Set(input.files.map((path) => normalizedPath(path).split("/").at(-1)));
  return PACKAGE_MANAGER_LOCKS.find(([name]) => names.has(name))?.[1] ?? "npm";
}

export function cloudExpoCommand(packageManager: CloudExpoPackageManager): string {
  switch (packageManager) {
    case "bun":
      return "bunx expo";
    case "npm":
      return "npx expo";
    case "pnpm":
      return "pnpm exec expo";
    case "yarn":
      return "yarn expo";
  }
}

function segment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

export function cloudExpoMetroSessionId(allocation: Pick<RunAllocation, "id" | "attempt">): string {
  return `t3-${segment(allocation.id)}-${allocation.attempt}-expo-metro`.slice(0, 128);
}

export function cloudExpoStartedAt(allocation: RunAllocation): string | undefined {
  if (allocation.expoMetro?.status !== "enabled") return undefined;
  const readyAt =
    allocation.allocationState.status === "ready" ? allocation.allocationState.readyAt : undefined;
  if (readyAt === undefined) return allocation.expoMetro.requestedAt;
  return Date.parse(readyAt) > Date.parse(allocation.expoMetro.requestedAt)
    ? readyAt
    : allocation.expoMetro.requestedAt;
}

export function cloudExpoLogs(output: string): string {
  return output.length <= CLOUD_EXPO_LOG_LIMIT ? output : output.slice(-CLOUD_EXPO_LOG_LIMIT);
}

export function cloudExpoLastClientConnectionAt(output: string): string | undefined {
  const lines = output.split(/\r?\n/).toReversed();
  for (const line of lines) {
    if (!/(?:android|ios) bundled|client connected|connected to metro/i.test(line)) continue;
    const match = /^\[([^\]]+)]/.exec(line);
    if (match?.[1] !== undefined && Number.isFinite(Date.parse(match[1]))) return match[1];
  }
  return undefined;
}

export function cloudExpoProcessFailure(output: string): {
  readonly kind: "port-conflict" | "tunnel" | "metro";
  readonly reason: string;
  readonly retryable: boolean;
} {
  if (/port\s+8081.*(?:in use|already)|eaddrinuse/i.test(output)) {
    return {
      kind: "port-conflict",
      reason: "Port 8081 is already in use inside the Daytona sandbox.",
      retryable: true,
    };
  }
  if (/ngrok|tunnel.*(?:closed|failed|timed out|too long)|failed.*tunnel/i.test(output)) {
    return {
      kind: "tunnel",
      reason: "Expo could not establish the ngrok tunnel.",
      retryable: true,
    };
  }
  return {
    kind: "metro",
    reason: "Expo CLI stopped before Metro became ready.",
    retryable: true,
  };
}
