# T3 Code docs

## Using T3 Code

- [Install T3 Code](./user/install.md)
- [Run the controller with Docker](./user/docker-controller.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [SnapShots](./user/snap-shot.md)
- [Import browser sessions](./user/browser-import.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Cloud Agents API](./user/cloud-agents-api.md)
- [Cloud agent security controls](./user/cloud-agent-security.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Running in the background](./user/background-service.md)
- [Updating T3 Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Cloud agent execution ownership](./internals/cloud-agent-execution.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Permanent cloud controller](./operations/permanent-controller.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
