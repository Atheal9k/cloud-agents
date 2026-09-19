# Migrate an environment to builds

Use this workflow when the user asks to migrate an existing saved environment to prebuilt baselines, test whether builds will work, or follow the build migration guide. The request is explicit permission to trigger the migration test build when the required tools are available.

## Establish the current source

1. Call `environment-info` and require an environment ID. Record its URL, `environmentJsonPath`, saved configuration, current build settings, and default revision when available.
2. If no environment ID exists, stop using this workflow and use the greenfield create flow instead.
3. For a repository-managed environment, read the effective `.cursor/environment.json` and referenced files from the revision the build will use.
4. For a DB-managed environment, capture the complete proposed configuration. Do not assume unsaved dashboard edits are part of the build.
5. Check required secrets, repository dependencies, egress rules, registry access, architecture, disk needs, and external service permissions.

Migration changes startup timing. `install` becomes build-time baseline preparation and does not rerun on each pod boot. Move per-pod work into `start` or `terminals` before testing the migration.

## Make the setup build-safe

- `install` must be deterministic, non-interactive, idempotent, and finite.
- `install` may create durable dependency or generated-file state. It must not launch a server, watcher, worker, Docker daemon, or other process expected to survive into the agent.
- `start` must reconcile per-boot state, avoid duplicates, check readiness, and return.
- `terminals` should contain named long-running foreground processes with useful logs.
- The selected runtime user must exist in the base image and be able to read the checkout and generated state.
- Do not bake repository source, credentials, or environment-specific secrets into the image.

Run the install command twice, exercise startup independently, run focused repository checks, and complete one representative product action before spending a remote build.

## Resolve blockers first

Use `cursor-cloud-request-environment-setup-actions` for confirmed missing secrets, egress domains, or external actions when available. Do not trigger the migration build until required blockers and locally fixable failures are cleared.

## Trigger and inspect the migration build

1. For repository-managed setup, ensure the selected ref contains the configuration under test. Use a non-default ref only when needed and supported by the build tool.
2. For DB-managed setup, pass the complete `environmentJson` override. Include a READY snapshot when the workflow produced one and the tool schema supports it.
3. Call `trigger-environment-build` for the existing environment and save the returned build ID.
4. Poll that exact build with `list-environment-builds` until it reaches `SUCCEEDED` or `FAILED`.
5. Read the complete `environment-build-logs`. Fix the earliest failing layer and create a new build; completed builds are immutable.

A successful image build proves only that the baseline was created. It does not prove that per-pod startup works.

## Verify the exact build in a fresh agent

When build selection is supported, boot a fresh cloud subagent with `cloud_requested_environment_build_id` set to the successful build ID. Include `cloud_base_branch` only when the build used a non-default ref. Ask it to:

1. report the requested build identity if visible;
2. check required tool versions, dependency state, and generated files;
3. run or inspect the configured startup path;
4. confirm service readiness;
5. perform a small health check, focused test, or core product action;
6. avoid production endpoints and mutations.

If exact build selection is unavailable, report the successful build but say that fresh-agent verification was skipped.

## Finish the migration

For DB-managed setup, propose the final configuration with the successful `buildId` when the proposal tool supports it. For repository-managed setup, the tested repository revision remains the source of truth.

Do not claim that builds were enabled, saved, or applied merely because the draft build passed. If the platform requires the user to enable builds or Save in the dashboard, give that as the remaining action. Environment changes affect newly started agents; they do not migrate the running agent.
