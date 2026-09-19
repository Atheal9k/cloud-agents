# Update a DB-managed environment

Use this workflow only after `environment-info` reports an environment ID and a null or absent `environmentJsonPath`. The saved personal or team environment is the effective source. A local `.cursor/environment.json` may exist on another branch or in the working tree without controlling this run.

## Inspect before changing

1. Record the environment ID, URL, saved environment configuration, build state, and inherited network policy from `environment-info` when available.
2. Inspect the repository's setup docs, manifests, lockfiles, tool-version files, and service topology.
3. Determine whether the saved setup uses Cursor's default image, an explicit image, inline Dockerfile contents, or a snapshot. Keep only one base strategy in the proposed configuration.
4. Check the current public schema before using less-common fields.
5. Confirm required secrets, repository access, egress domains, test accounts, and external services. Do not expose their values.

Do not create `.cursor/environment.json` unless the user asks to migrate setup into the repository. This workflow updates the dashboard-managed environment.

## Develop and validate the change locally

Reproduce the proposed lifecycle in the current machine before creating a proposal:

1. Install any required system tools that are safe to add locally.
2. Run the proposed `install` command twice.
3. Run the proposed `start` logic and terminal commands independently. Confirm restart safety and readiness.
4. Run focused lint, type-check, test, and development build commands for the requested scope.
5. Exercise one representative product action.

If the base image must change, use a deterministic, non-interactive Dockerfile. Use inline `dockerfileContents` only when the dashboard flow supports it and a repository-managed Dockerfile is not appropriate.

## Handle blockers

When a required secret, test login, egress rule, repository permission, or provider-console action is missing, call `cursor-cloud-request-environment-setup-actions` when available. Continue independent work, but do not snapshot, build, propose, or ask the user to Save until all required actions are resolved.

## Snapshot and optional build-test

Take a snapshot only when the snapshot tools are available and the working VM represents the final validated install state:

1. Run the final install command successfully.
2. Take a fresh snapshot and wait until it reports READY.
3. Any later VM or install-script change invalidates that snapshot. Rerun install and take another one.

A request to edit or improve a DB-managed environment does not by itself authorize an environment build. Trigger a draft build only when the user explicitly asks to build, test, verify, or migrate it, or when they invoked a command whose documented purpose includes build testing.

When a build is requested:

1. Pass the complete proposed `environmentJson` and READY snapshot when supported so the draft does not depend on unsaved dashboard state.
2. Poll the exact build ID until `SUCCEEDED` or `FAILED`, then inspect its complete logs.
3. Fix the earliest failure, repeat affected local checks, take a new snapshot when needed, and create a new build.
4. Verify a successful build in a fresh cloud subagent selected by that exact build ID when supported.

Do not claim fresh-agent verification if the platform could not select the tested build.

## Propose and hand off

After required local validation succeeds, call `cursor-cloud-propose-environment-json` when available with the complete final configuration. When an exact draft build was tested, pass its ID as top-level `buildId`. Do not put the raw snapshot ID on the proposal when `buildId` should carry the validated baseline.

The proposal is not saved configuration. Tell the user to review and Save it in the Environment panel. Report the effective source, validation that ran, tested build when applicable, and any unavailable verification. Never say the environment was updated until the user saves it and starts a new agent from the new configuration.
