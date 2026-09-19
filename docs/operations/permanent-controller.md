# Permanent controller

The permanent controller is the same image and the same state layout as the
local Docker controller, running on an always-on EC2 host. Moving to it is a
one-way cutover of a single writer: the old controller stops, its state is
copied, and exactly one controller is adopted afterwards.

Local-controller mode stays supported. Both modes speak the same contracts, so
a client cannot tell them apart except through
`CloudAllocationSnapshot.controller`, where `mode` is `local` or `permanent`
and `requiresHostOnline` says whether the operator's own machine has to stay
up.

## Provision the host

1. Publish the controller image from a clean revision and note its digest. The
   [Docker controller guide](../user/docker-controller.md#update-publish-and-roll-back)
   covers the build.
2. Create a reusable, pre-approved Tailscale auth key, store the raw value in
   Secrets Manager, and set `controller_tailscale_auth_key_secret_arn`,
   `controller_tailscale_hostname`, and `controller_tailnet_domain`.
3. Set `controller_image_ref` to the published digest, `controller_mode` to
   `ec2`, and any extra settings in `controller_runtime_environment`. Secret
   values never go here; pass Secrets Manager names through `*_SECRET_REF`
   entries.
4. Apply `infra/cloud-agents`. The `controller.url` output is the stable URL
   clients and workers use. Confirm the host answers there before moving any
   state onto it.

Rebooting the instance must be enough to bring the controller back. The data
volume mounts from `/etc/fstab`, `t3-controller.service` is enabled, and the
unit pulls the pinned image before starting the container, so identity,
settings, secrets, the agent and run catalog, environment versions, Build
records, and artifact references all come back with it.

## Cut over from a local controller

The fence is what makes "exactly one writable controller" enforceable rather
than a promise. `t3 cloud fence` marks the state directory, the mark travels
into the backup, and both copies refuse writes until one of them is adopted.
A fenced controller still serves reads, so saved results stay reviewable
throughout.

1. Stop admission from any client with orchestration write access, or through
   the `cloud.allocations.setAdmission` operation. New launches and retries are
   rejected; accepted runs keep going.
2. Let the active runs finish and reach cleanup. In-flight worker processes do
   not migrate; a run that is still working when the old controller stops is
   lost work, not a run that resumes elsewhere.
3. Stop the old controller. `t3 cloud status --base-dir <t3-home>` prints what
   is left; it names any allocation still awaiting cleanup.
4. Fence it:

   ```bash
   node apps/server/src/bin.ts cloud fence --base-dir <t3-home> \
     --reason "Moved to the permanent controller."
   ```

   The command refuses while a server is running against that directory, and
   refuses while any allocation has not finished cleanup. It reports how many
   agents and runs the backup will carry.

5. Back up the whole state directory cold, as described under
   [Backup and restore](../user/docker-controller.md#backup-and-restore). The
   database alone is not enough: environment identity, settings, and secrets
   live beside it and must cut over at the same point.
6. Restore the archive into `/var/lib/t3` on the permanent host with the
   controller service stopped.
7. Adopt it there:

   ```bash
   systemctl stop t3-controller
   docker run --rm --volume /var/lib/t3:/var/lib/t3 <controller-image-ref> \
     cloud adopt --base-dir /var/lib/t3
   systemctl start t3-controller
   ```

   Adoption clears the fence and prints the agent IDs it kept, which are the
   same IDs clients already hold. Admission stays stopped, so nothing is
   admitted between the container starting and your checking it.

8. Reopen admission and launch one review-only run end to end before trusting
   the move.

Keep the old state directory. Until the permanent controller has served a full
run, it is the rollback. Never unfence both copies.

## Authentication after the move

Provider and source-control credentials are controller-side and remote-safe
already: the controller reads the Git SSH key and GitHub token from Secrets
Manager for each operation, and workers restore provider credentials from their
own scoped secrets. Nothing depends on a browser's `gh` login or on a callback
listener bound to the operator's machine.

A loopback URL a server prints names the server, not the viewer. `t3 pair` says
so when the URL it mints is loopback-only; on the permanent host, pair through
the tailnet URL instead:

```bash
docker exec t3-controller node /opt/t3/dist/bin.mjs pair --base-dir /var/lib/t3
```

## Upgrade, roll back, and outages

An upgrade is a new `controller_image_ref` and a restart; the service pulls on
every start. Take a cold backup first, because database migrations may be
forward-only and an older image is only safe when it supports the current
schema. A rollback that cannot run the current schema is a restore of the
pre-upgrade backup into a fresh copy of the volume, not an image change.

When the host is unreachable, the scheduled expiry cleanup still terminates
workers past their tagged deadline, so an outage cannot leave compute running
indefinitely. Idle agents hold no runtime, so restoring the controller does not
start anything: recovery brings back the catalog and leaves each agent where it
was.

If a restore is ever ambiguous about which copy is authoritative, fence both and
adopt one deliberately. Two writable controllers over one allocation catalog
would launch and terminate the same workers.
