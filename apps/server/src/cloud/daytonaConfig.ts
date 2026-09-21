import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ManagedRuntimeAdmission = Schema.Literals(["daytona", "disabled"]);
export type ManagedRuntimeAdmission = typeof ManagedRuntimeAdmission.Type;

export interface ResolvedDaytonaConfig {
  readonly admission: ManagedRuntimeAdmission;
  readonly apiKey?: string;
  readonly apiUrl: string;
  readonly target: string;
  readonly resourceClass: string;
  readonly project: string;
  readonly cpu?: number;
  readonly memoryGib?: number;
  readonly diskGib?: number;
}

export class DaytonaConfigError extends Schema.TaggedError<DaytonaConfigError>()(
  "DaytonaConfigError",
  { message: Schema.String },
) {}

const decodeAdmission = Schema.decodeUnknownEffect(ManagedRuntimeAdmission);

const DaytonaConfig = Config.all({
  admission: Config.string("T3CODE_CLOUD_MANAGED_PROVIDER").pipe(Config.withDefault("daytona")),
  apiKey: Config.redacted("DAYTONA_API_KEY").pipe(Config.option),
  apiUrl: Config.string("DAYTONA_API_URL").pipe(Config.withDefault("https://app.daytona.io/api")),
  target: Config.string("DAYTONA_TARGET").pipe(Config.withDefault("us")),
  resourceClass: Config.string("T3CODE_DAYTONA_RESOURCE_CLASS").pipe(Config.withDefault("default")),
  project: Config.string("T3CODE_CLOUD_PROJECT").pipe(Config.withDefault("t3-cloud-agents")),
  cpu: Config.int("T3CODE_DAYTONA_CPU").pipe(Config.option),
  memoryGib: Config.int("T3CODE_DAYTONA_MEMORY_GIB").pipe(Config.option),
  diskGib: Config.int("T3CODE_DAYTONA_DISK_GIB").pipe(Config.option),
});

export const resolveDaytonaConfig = Effect.fn("cloud.resolveDaytonaConfig")(function* () {
  const config = yield* DaytonaConfig.pipe(
    Effect.mapError(
      (error: Config.ConfigError) =>
        new DaytonaConfigError({
          message: `The Daytona configuration could not be read: ${error.message}`,
        }),
    ),
  );
  const admission = yield* decodeAdmission(config.admission).pipe(
    Effect.mapError(
      () =>
        new DaytonaConfigError({
          message: "T3CODE_CLOUD_MANAGED_PROVIDER must be daytona or disabled.",
        }),
    ),
  );
  const apiKey = Option.isNone(config.apiKey) ? undefined : Redacted.value(config.apiKey.value);
  return {
    admission,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    apiUrl: config.apiUrl,
    target: config.target,
    resourceClass: config.resourceClass,
    project: config.project,
    ...(Option.isNone(config.cpu) ? {} : { cpu: config.cpu.value }),
    ...(Option.isNone(config.memoryGib) ? {} : { memoryGib: config.memoryGib.value }),
    ...(Option.isNone(config.diskGib) ? {} : { diskGib: config.diskGib.value }),
  } satisfies ResolvedDaytonaConfig;
});
