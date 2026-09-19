import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  type CloudEnvironmentConfig,
  type CloudEnvironmentSecretReference,
  type CloudEnvironmentTerminal,
  type CloudEnvironmentVersion,
  cloudEnvironmentSecretScope,
} from "./cloudEnvironment.ts";
import { cloudEnvironmentBuildSecrets } from "./cloudEnvironmentBuild.ts";
import {
  type CloudRepositoryCommand,
  CloudRepositoryCommandResult,
  type CloudRepositoryRecipe,
} from "./cloudRepository.ts";
import * as Schema from "effect/Schema";

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quotePosixShellWord(value: string): string {
  return SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(command: CloudRepositoryCommand): string {
  return [command.command, ...command.args].map(quotePosixShellWord).join(" ");
}

/**
 * Cursor's terminals field may nest groups. Boot and admission always see a
 * flat list of named commands.
 */
export function flattenCloudEnvironmentTerminals(
  terminals: CloudEnvironmentConfig["terminals"],
): ReadonlyArray<CloudEnvironmentTerminal> {
  if (terminals === undefined) return [];
  return terminals.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

export const CloudEnvironmentRuntimeServiceKind = Schema.Literals(["start", "terminal"]);
export type CloudEnvironmentRuntimeServiceKind = typeof CloudEnvironmentRuntimeServiceKind.Type;

export const CloudEnvironmentRuntimeService = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: CloudEnvironmentRuntimeServiceKind,
  command: TrimmedNonEmptyString,
  port: Schema.optionalKey(PortSchema),
});
export type CloudEnvironmentRuntimeService = typeof CloudEnvironmentRuntimeService.Type;

/**
 * `install` is Build-only. Each runtime boot runs `start` and named terminals.
 * The first declared port is the health check for `start` when it has no name.
 */
export function cloudEnvironmentRuntimeServices(
  config: CloudEnvironmentConfig,
): ReadonlyArray<CloudEnvironmentRuntimeService> {
  const ports = config.ports ?? [];
  const portByName = new Map(
    ports.flatMap((port) => (port.name === undefined ? [] : ([[port.name, port.port]] as const))),
  );
  const services: Array<CloudEnvironmentRuntimeService> = [];
  const start = config.start?.trim();
  if (start !== undefined && start.length > 0) {
    const namedStartPort = portByName.get("start");
    const port = namedStartPort ?? ports[0]?.port;
    services.push({
      name: "start",
      kind: "start",
      command: start,
      ...(port === undefined ? {} : { port }),
    });
  }
  flattenCloudEnvironmentTerminals(config.terminals).forEach((terminal, index) => {
    const name = terminal.name ?? `terminal-${index + 1}`;
    const port = portByName.get(name);
    services.push({
      name,
      kind: "terminal",
      command: terminal.command,
      ...(port === undefined ? {} : { port }),
    });
  });
  return services;
}

export const CloudEnvironmentRuntimeServiceHealth = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: CloudEnvironmentRuntimeServiceKind,
  status: Schema.Literals(["healthy", "unhealthy"]),
  port: Schema.optionalKey(PortSchema),
  message: TrimmedNonEmptyString,
  log: CloudRepositoryCommandResult,
});
export type CloudEnvironmentRuntimeServiceHealth = typeof CloudEnvironmentRuntimeServiceHealth.Type;

export const CloudEnvironmentRuntimeBootRecord = Schema.Struct({
  services: Schema.Array(CloudEnvironmentRuntimeServiceHealth),
});
export type CloudEnvironmentRuntimeBootRecord = typeof CloudEnvironmentRuntimeBootRecord.Type;

/**
 * CA-10 recipes become an environment version: setup is terminating `install`,
 * the first dev server is per-boot `start`, the rest are named terminals.
 * Recipe secrets are ordinary runtime environment variables until a person
 * marks them Build-only or redacted.
 */
export function cloudEnvironmentFromRecipe(input: {
  readonly recipe: CloudRepositoryRecipe;
  readonly image: string;
}): {
  readonly config: CloudEnvironmentConfig;
  readonly secretReferences: ReadonlyArray<CloudEnvironmentSecretReference>;
} {
  const { recipe } = input;
  const [primary, ...rest] = recipe.devServers;
  const terminals = rest.map((server) => ({
    name: server.name,
    command: shellCommand(server.command),
  }));
  return {
    config: {
      image: input.image,
      install: recipe.setup.map(shellCommand).join("\n"),
      ...(primary === undefined ? {} : { start: shellCommand(primary.command) }),
      ...(terminals.length === 0 ? {} : { terminals }),
      ports: recipe.devServers.map((server) => ({ name: server.name, port: server.port })),
    },
    secretReferences: recipe.secretReferences.map((secret) => ({
      name: secret.environmentVariable,
      reference: secret.reference,
      availability: "runtime",
    })),
  };
}

export function cloudEnvironmentSecretValidationMessage(
  secrets: ReadonlyArray<CloudEnvironmentSecretReference>,
): string | undefined {
  const names = new Set<string>();
  const references = new Set<string>();
  for (const secret of secrets) {
    if (cloudEnvironmentSecretScope(secret) === "user" && secret.availability === "build") {
      return `User secret '${secret.name}' cannot be Build-only. User secrets never enter a shared Build.`;
    }
    if (names.has(secret.name)) return `Secret '${secret.name}' is duplicated.`;
    if (references.has(secret.reference)) {
      return `Secret reference '${secret.reference}' is duplicated.`;
    }
    names.add(secret.name);
    references.add(secret.reference);
  }
}

export type CloudEnvironmentBuildAdmission =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly message: string };

/**
 * Multi-repo Builds are rejected before they clone when ports collide, a
 * private dependency is unnamed, a repository has no default ref, or a user
 * secret would be baked into the snapshot.
 */
export function admitCloudEnvironmentBuild(input: {
  readonly version: Pick<CloudEnvironmentVersion, "repositories" | "config" | "secretReferences">;
  readonly gitSetup?: ReadonlyArray<{
    readonly repository: string;
    readonly defaultRef: string;
    readonly commit: string;
  }>;
}): CloudEnvironmentBuildAdmission {
  const { version } = input;
  const repositories = version.repositories;
  if (repositories.length === 0) {
    return { status: "rejected", message: "The environment has no repository to prepare." };
  }

  const seenRepos = new Set<string>();
  for (const entry of repositories) {
    if (seenRepos.has(entry.repository)) {
      return {
        status: "rejected",
        message: `Repository '${entry.repository}' is listed more than once.`,
      };
    }
    if (entry.defaultRef.trim().length === 0) {
      return {
        status: "rejected",
        message: `Repository '${entry.repository}' has no default ref.`,
      };
    }
    seenRepos.add(entry.repository);
  }

  for (const dependency of version.config.repositoryDependencies ?? []) {
    if (!seenRepos.has(dependency)) {
      return {
        status: "rejected",
        message: `Private dependency '${dependency}' is not listed as an environment repository with a per-repo ref.`,
      };
    }
  }

  const ports = new Set<number>();
  for (const port of version.config.ports ?? []) {
    if (ports.has(port.port)) {
      return { status: "rejected", message: `Port ${port.port} is declared more than once.` };
    }
    ports.add(port.port);
  }

  const secretError = cloudEnvironmentSecretValidationMessage(version.secretReferences);
  if (secretError !== undefined) return { status: "rejected", message: secretError };

  if (input.gitSetup !== undefined) {
    const byRepository = new Map(input.gitSetup.map((entry) => [entry.repository, entry]));
    for (const entry of repositories) {
      const resolved = byRepository.get(entry.repository);
      if (resolved === undefined || resolved.commit.trim().length === 0) {
        return {
          status: "rejected",
          message: `Repository '${entry.repository}' has no resolved commit for '${entry.defaultRef}'.`,
        };
      }
    }
  }

  return { status: "accepted" };
}

export type CloudEnvironmentSecretPhase = "build" | "runtime";

export function injectCloudEnvironmentSecrets(input: {
  readonly phase: CloudEnvironmentSecretPhase;
  readonly secrets: ReadonlyArray<CloudEnvironmentSecretReference>;
  readonly values: Readonly<Record<string, string>>;
}): {
  readonly env: Record<string, string>;
  readonly redact: ReadonlyArray<string>;
} {
  const eligible =
    input.phase === "build"
      ? cloudEnvironmentBuildSecrets(input.secrets)
      : input.secrets.filter(
          (secret) =>
            secret.availability === "runtime" || secret.availability === "runtime-redacted",
        );
  const env: Record<string, string> = {};
  const redact: Array<string> = [];
  for (const secret of eligible) {
    const value = input.values[secret.reference];
    if (value === undefined) continue;
    env[secret.name] = value;
    if (secret.availability !== "runtime") redact.push(value);
  }
  return { env, redact };
}

export function missingCloudEnvironmentSecrets(input: {
  readonly phase: CloudEnvironmentSecretPhase;
  readonly secrets: ReadonlyArray<CloudEnvironmentSecretReference>;
  readonly values: Readonly<Record<string, string>>;
}): ReadonlyArray<CloudEnvironmentSecretReference> {
  const injected = injectCloudEnvironmentSecrets(input);
  const expected =
    input.phase === "build"
      ? cloudEnvironmentBuildSecrets(input.secrets)
      : input.secrets.filter(
          (secret) =>
            secret.availability === "runtime" || secret.availability === "runtime-redacted",
        );
  return expected.filter((secret) => injected.env[secret.name] === undefined);
}

/** Longest values first so a token is not left behind inside a longer secret. */
export function redactCloudEnvironmentSecretOutput(
  text: string,
  values: ReadonlyArray<string>,
): string {
  const unique = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return unique.reduce((output, value) => output.split(value).join("[redacted]"), text);
}
