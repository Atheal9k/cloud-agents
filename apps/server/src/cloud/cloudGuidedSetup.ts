/**
 * Guided setup translates the settings form into the same environment save the
 * rest of the system uses. Keeping the translation here, and pure, means the
 * screen cannot invent a config shape the resolver would reject.
 */
import type {
  CloudEnvironmentConfig,
  CloudEnvironmentSaveInput,
  CloudEnvironmentSource,
  CloudGuidedSetupInput,
} from "@t3tools/contracts";

function source(input: CloudGuidedSetupInput): CloudEnvironmentSource {
  if (input.scope === "default") return { type: "saved", scope: "default" };
  return {
    type: "saved",
    scope: input.scope,
    // An owned scope needs a name; the environment id is the stable fallback.
    owner: input.owner ?? input.environmentId,
  };
}

function config(input: CloudGuidedSetupInput): CloudEnvironmentConfig {
  const install = input.install?.trim() ?? "";
  const start = input.start?.trim() ?? "";
  return {
    name: input.name,
    ...(input.base.kind === "image"
      ? { image: input.base.image }
      : { build: { dockerfile: input.base.dockerfile } }),
    ...(install.length === 0 ? {} : { install }),
    ...(start.length === 0 ? {} : { start }),
  };
}

export function cloudGuidedSetupSaveInput(input: CloudGuidedSetupInput): CloudEnvironmentSaveInput {
  return {
    environmentId: input.environmentId,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    name: input.name,
    source: source(input),
    repositories: [
      { repository: input.repository, defaultRef: input.defaultRef },
      ...(input.additionalRepositories ?? []),
    ],
    config: config(input),
    secretReferences: input.secretReferences,
    occurredAt: input.occurredAt,
  };
}
