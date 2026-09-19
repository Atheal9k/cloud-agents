# Update a repository-managed environment

Use this workflow only after `environment-info` reports a non-empty `environmentJsonPath`. The repository file is the effective configuration. Do not create or propose a competing dashboard-managed configuration.

## Inspect the effective setup

1. Record the environment ID, URL, `environmentJsonPath`, current build state, and selected repository revision from `environment-info` when those fields are available.
2. Read `.cursor/environment.json` from the effective revision and every Dockerfile or script it references.
3. Read repository guidance, pinned tool versions, lockfiles, setup docs, and the commands used by hooks or CI for the affected scope.
4. Check the current public environment schema before adding or changing fields. Do not add `$schema` to the JSON document.
5. Identify secrets, egress rules, repository dependencies, or external accounts that the change needs. Confirm a requirement is missing before reporting it as a blocker.

If the local checkout differs from the effective revision, say which source you inspected. A build cannot test unpushed or otherwise unreachable repository changes unless the build tool accepts an explicit configuration override that contains the complete setup under test.

## Make the smallest repository change

- Keep stable operating-system dependencies and toolchains in the Dockerfile.
- Keep source-dependent, idempotent work in `install`.
- Put per-boot daemon reconciliation in `start`.
- Put visible long-running servers, workers, and watchers in `terminals`.
- Preserve the repository's package manager, lockfile, runtime user, and existing setup conventions.
- Do not copy the repository into the image or commit credentials.
- Change referenced scripts only when the environment needs them. Do not change application code to hide an environment failure.

## Validate before building

Run the smallest proof that covers the change:

1. Validate the JSON against the current public schema.
2. Build the Dockerfile locally when the required container tooling is available and the change affects it.
3. Run the final install command twice to prove idempotence.
4. Run `start` or the relevant terminal commands and check readiness.
5. Run the repository's focused lint, type-check, test, and development build commands for the affected scope.
6. Exercise one real product action. Starting a process or loading an empty page is not enough.

Do not trigger a Cloud Agent build while a locally fixable validation failure remains.

## Handle external blockers

When a required secret, test account, egress rule, repository permission, or provider-console action is confirmed missing, use `cursor-cloud-request-environment-setup-actions` when available. Request only the supported action types. Continue independent local work, but do not build or claim validation until every required blocker is resolved.

Never put secret values in repository files, logs, or chat output.

## Build-test the repository revision

For this workflow, a request to change, improve, build, or test the repository-managed environment is explicit permission to run the environment build path when the tools are available.

1. Ensure the build can resolve a repository revision containing the configuration under test. If the changes are only local and the tool cannot accept a complete override, stop before building and explain that a reachable revision is required.
2. Call `trigger-environment-build` for the environment ID. Pass the non-default ref only when required by the tool schema; otherwise let it use the repository's default revision.
3. Poll `list-environment-builds` for the returned build ID until it reaches `SUCCEEDED` or `FAILED`.
4. Read the complete log with `environment-build-logs`. On failure, fix the earliest failing layer, repeat local validation, and trigger a new immutable build.
5. After success, boot a fresh cloud subagent from that exact build when build selection is supported. Ask it to report the build identity, check tool versions and generated state, start or inspect required services, and run a representative health check or product action without touching production.

If fresh-agent build selection is unavailable or rejected, disclose that gap. Do not claim that the successful build was tested in a fresh agent.

## Report the result

State which repository files changed, the effective source, local validation, build ID and outcome, and fresh-agent evidence when it exists. Repository-managed changes become effective only after the relevant revision is available to a newly started Cloud Agent. Do not imply that the current agent was rebuilt or that dashboard settings were saved.
