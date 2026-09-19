import * as NodeCrypto from "node:crypto";

import {
  type CloudCommitProvenance,
  type CloudCommitSignature,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  CLOUD_COMMIT_SIGNING_IDENTITY_EMAIL,
  CLOUD_COMMIT_SIGNING_IDENTITY_NAME,
  authorizeCloudCommitSigner,
  cloudCommitSigningBacking,
  type CloudCommitSignerCaller,
} from "./cloudCommitSigningPolicy.ts";

export class CloudCommitSignerError extends Schema.TaggedError<CloudCommitSignerError>()(
  "CloudCommitSignerError",
  {
    reason: Schema.Literals(["unauthorized", "signer-unavailable", "git-failed", "verify-failed"]),
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export interface CloudCommitSignResult {
  readonly commit: string;
  readonly signature: CloudCommitSignature;
  readonly publicKey: string;
}

export class CloudCommitSigner extends Context.Service<
  CloudCommitSigner,
  {
    readonly publicKey: Effect.Effect<string, CloudCommitSignerError>;
    readonly keyId: Effect.Effect<string, CloudCommitSignerError>;
    readonly fingerprint: Effect.Effect<string, CloudCommitSignerError>;
    readonly available: Effect.Effect<boolean>;
    readonly signCommit: (input: {
      readonly caller: CloudCommitSignerCaller;
      readonly allowedRepository: string;
      readonly cwd: string;
      readonly baseCommit: string;
      readonly message: string;
      readonly provenance: CloudCommitProvenance;
    }) => Effect.Effect<CloudCommitSignResult | null, CloudCommitSignerError>;
  }
>()("t3/cloud/CloudCommitSigner") {}

interface CloudCommitSignerMakeInput {
  readonly keyRoot: string;
  readonly kmsKeyArn?: string;
}

function signerError(input: {
  readonly reason: CloudCommitSignerError["reason"];
  readonly message: string;
  readonly retryable: boolean;
}): CloudCommitSignerError {
  return new CloudCommitSignerError(input);
}

export const make = Effect.fn("CloudCommitSigner.make")(function* (
  input: CloudCommitSignerMakeInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const backing = cloudCommitSigningBacking(input.kmsKeyArn);
  const privateKeyPath = path.join(input.keyRoot, "id_ed25519");
  const publicKeyPath = path.join(input.keyRoot, "id_ed25519.pub");
  const allowedSignersPath = path.join(input.keyRoot, "allowed_signers");

  const run = Effect.fn("CloudCommitSigner.run")(function* (request: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly stdin?: string;
  }) {
    return yield* runner
      .run({
        command: request.command,
        args: request.args,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        timeout: "1 minute",
        maxOutputBytes: 256 * 1024,
      })
      .pipe(
        Effect.mapError(() =>
          signerError({
            reason: "signer-unavailable",
            message: "The controller could not invoke the commit signer.",
            retryable: true,
          }),
        ),
      );
  });

  const ensureKey = Effect.fn("CloudCommitSigner.ensureKey")(function* () {
    yield* fs.makeDirectory(input.keyRoot, { recursive: true }).pipe(
      Effect.mapError(() =>
        signerError({
          reason: "signer-unavailable",
          message: "The controller could not create the commit-signing key directory.",
          retryable: true,
        }),
      ),
    );
    yield* fs.chmod(input.keyRoot, 0o700).pipe(Effect.ignore);
    const hasPrivate = yield* fs.exists(privateKeyPath).pipe(Effect.orElseSucceed(() => false));
    const hasPublic = yield* fs.exists(publicKeyPath).pipe(Effect.orElseSucceed(() => false));
    if (!hasPrivate || !hasPublic) {
      const generated = yield* run({
        command: "ssh-keygen",
        args: [
          "-t",
          "ed25519",
          "-f",
          privateKeyPath,
          "-N",
          "",
          "-C",
          CLOUD_COMMIT_SIGNING_IDENTITY_EMAIL,
        ],
      });
      if (generated.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "signer-unavailable",
          message: "The controller could not generate the per-service commit-signing key.",
          retryable: true,
        });
      }
      yield* fs.chmod(privateKeyPath, 0o600).pipe(Effect.ignore);
    }
    const publicKey = yield* fs.readFileString(publicKeyPath).pipe(
      Effect.mapError(() =>
        signerError({
          reason: "signer-unavailable",
          message: "The controller could not read the commit-signing public key.",
          retryable: true,
        }),
      ),
    );
    yield* fs.writeFileString(
      allowedSignersPath,
      `${CLOUD_COMMIT_SIGNING_IDENTITY_EMAIL} namespaces="git" ${publicKey.trim()}\n`,
    ).pipe(
      Effect.mapError(() =>
        signerError({
          reason: "signer-unavailable",
          message: "The controller could not write the commit-signing allowed signers file.",
          retryable: true,
        }),
      ),
    );
    return publicKey.trim();
  });

  const keyIdOf = (publicKey: string) =>
    NodeCrypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);

  const fingerprintOf = Effect.fn("CloudCommitSigner.fingerprintOf")(function* () {
    yield* ensureKey();
    const listed = yield* run({
      command: "ssh-keygen",
      args: ["-lf", publicKeyPath, "-E", "sha256"],
    });
    if (listed.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* signerError({
        reason: "signer-unavailable",
        message: "The controller could not fingerprint the commit-signing key.",
        retryable: true,
      });
    }
    const match = /SHA256:[A-Za-z0-9+/=]+/.exec(listed.stdout);
    if (match === null) {
      return yield* signerError({
        reason: "signer-unavailable",
        message: "The commit-signing key fingerprint was unreadable.",
        retryable: true,
      });
    }
    return match[0];
  });

  const git = Effect.fn("CloudCommitSigner.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    return yield* run({ command: "git", args, cwd, ...(stdin === undefined ? {} : { stdin }) });
  });

  const signCommit: CloudCommitSigner["Service"]["signCommit"] = (request) =>
    Effect.gen(function* () {
      const authorized = authorizeCloudCommitSigner({
        caller: request.caller,
        allowedRepository: request.allowedRepository,
      });
      if (!authorized.allowed) {
        return yield* signerError({
          reason: "unauthorized",
          message: authorized.message,
          retryable: false,
        });
      }
      if (request.caller.kind !== "trusted-publication") {
        return yield* signerError({
          reason: "unauthorized",
          message: "The commit signer is only available to controller-owned publication.",
          retryable: false,
        });
      }
      const publicKey = yield* ensureKey();
      const fingerprint = yield* fingerprintOf();
      const keyId = keyIdOf(publicKey);
      const trusted = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${privateKeyPath}`,
        "-c",
        `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
        "-c",
        "commit.gpgsign=true",
        "-c",
        `user.name=${CLOUD_COMMIT_SIGNING_IDENTITY_NAME}`,
        "-c",
        `user.email=${CLOUD_COMMIT_SIGNING_IDENTITY_EMAIL}`,
      ];
      const staged = yield* git(request.cwd, [...trusted, "add", "--all", "--", "."]);
      if (staged.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "git-failed",
          message: "The controller could not stage the saved workspace changes.",
          retryable: true,
        });
      }
      const [status, diff] = yield* Effect.all([
        git(request.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(request.cwd, ["diff", "--quiet", request.baseCommit, "--", "."]),
      ]);
      if (status.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "git-failed",
          message: "The controller could not inspect the publication workspace.",
          retryable: true,
        });
      }
      if (
        diff.code !== ChildProcessSpawner.ExitCode(0) &&
        diff.code !== ChildProcessSpawner.ExitCode(1)
      ) {
        return yield* signerError({
          reason: "git-failed",
          message:
            "The controller could not compare the publication workspace with its base commit.",
          retryable: true,
        });
      }
      if (status.stdout.length === 0 && diff.code === ChildProcessSpawner.ExitCode(0)) {
        return null;
      }
      const reset = yield* git(request.cwd, [...trusted, "reset", "--soft", request.baseCommit]);
      if (reset.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "git-failed",
          message:
            "The controller could not collapse unpublished work onto the recorded base commit.",
          retryable: true,
        });
      }
      const committed = yield* git(
        request.cwd,
        [...trusted, "commit", "--no-verify", "-S", "--file", "-"],
        request.message,
      );
      if (committed.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "git-failed",
          message: "The controller could not create a signed publication commit.",
          retryable: true,
        });
      }
      const verified = yield* git(request.cwd, [...trusted, "verify-commit", "HEAD"]);
      if (verified.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* signerError({
          reason: "verify-failed",
          message: "The signed publication commit could not be verified with the service key.",
          retryable: true,
        });
      }
      const commit = (yield* git(request.cwd, ["rev-parse", "HEAD"])).stdout.trim();
      if (commit.length === 0) {
        return yield* signerError({
          reason: "git-failed",
          message: "The signed publication commit could not be read.",
          retryable: true,
        });
      }
      return {
        commit,
        publicKey,
        signature: {
          keyId,
          algorithm: "ssh-ed25519",
          format: "ssh",
          fingerprint,
          backing,
          signedAt: DateTime.formatIso(yield* DateTime.now),
        },
      } satisfies CloudCommitSignResult;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(CloudCommitSignerError)(error)
          ? error
          : signerError({
              reason: "signer-unavailable",
              message: "The controller could not complete commit signing.",
              retryable: true,
            }),
      ),
    );

  const mapSignerError = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        Schema.is(CloudCommitSignerError)(error)
          ? error
          : signerError({
              reason: "signer-unavailable",
              message: "The controller could not complete commit signing.",
              retryable: true,
            }),
      ),
    );

  yield* ensureKey();
  return CloudCommitSigner.of({
    publicKey: mapSignerError(ensureKey()),
    keyId: mapSignerError(ensureKey().pipe(Effect.map(keyIdOf))),
    fingerprint: mapSignerError(fingerprintOf()),
    available: ensureKey().pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    signCommit,
  });
});

export const layer = Layer.effect(
  CloudCommitSigner,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make({
      keyRoot: path.join(config.stateDir, "cloud-commit-signing"),
      ...(process.env.T3CODE_CLOUD_KMS_KEY_ARN === undefined ||
      process.env.T3CODE_CLOUD_KMS_KEY_ARN.trim().length === 0
        ? {}
        : { kmsKeyArn: process.env.T3CODE_CLOUD_KMS_KEY_ARN }),
    });
  }),
);
