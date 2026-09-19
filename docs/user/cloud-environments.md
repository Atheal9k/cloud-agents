# Cloud environments, multi-repo, and start from scratch

A saved environment can prepare more than one repository in a single Build. Each
repository keeps its own default ref. Agents that use the environment clone the
full set, make coordinated changes, and open a draft pull request in every
repository that actually changed.

Long-running is not available for multi-repo environments. Selecting more than
one repository turns that option off until the implementation proves it.

Dependent repositories and submodules cannot widen the triggering user's access.
They must already sit in the intersection of the source-control install, the
person who started the run, and the environment's configured repositories.

## Start from scratch

You can start a cloud agent without a repository. In the launch dialog choose
**Start from scratch**, or omit `repos` on `POST /v1/agents` when no default
repository is configured. The agent works in an isolated workspace.

When the work is ready, create a draft repository through the connected Git
provider (GitHub, GitLab, Bitbucket, or Azure DevOps). Names use letters, digits,
hyphens, and underscores, up to 100 characters. Visibility is private or
internal.

Port forwarding and Design Mode reuse the existing preview lease and artifact
boundary. Deploy from scratch waits until that draft repository exists.
