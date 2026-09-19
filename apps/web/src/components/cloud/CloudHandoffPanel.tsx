import { useAtomValue } from "@effect/atom-react";
import {
  CloudAgentId,
  type CloudHandoffConflictPolicy,
  type CloudHandoffDirection,
  type CloudHandoffIntent,
  type CloudHandoffPreview,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { cloudAllocations } from "../../state/cloudAllocations";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  cloudHandoffFileLabel,
  cloudHandoffIntentLabel,
  cloudHandoffResultSummary,
  cloudHandoffSelectedCount,
} from "../../cloud/cloudHandoffPresentation";

const selectClassName =
  "h-8.5 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs/5 outline-none focus:border-ring focus:ring-3 focus:ring-ring/24 sm:h-7.5";

export function CloudHandoffPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agentId?: CloudAgentId;
  readonly defaultDirection?: CloudHandoffDirection;
}) {
  const projects = useProjects();
  const snapshotResult = useAtomValue(
    cloudAllocations.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const agents = AsyncResult.getOrElse(snapshotResult, () => null)?.agents ?? [];
  const previewCommand = useAtomCommand(cloudAllocations.previewHandoff, { reportFailure: false });
  const executeCommand = useAtomCommand(cloudAllocations.executeHandoff, { reportFailure: false });
  const [direction, setDirection] = useState<CloudHandoffDirection>(
    props.defaultDirection ?? (props.agentId === undefined ? "local-to-cloud" : "cloud-to-local"),
  );
  const [intent, setIntent] = useState<CloudHandoffIntent>("linked-continuation");
  const [projectPath, setProjectPath] = useState(projects[0]?.workspaceRoot ?? "");
  const [agentId, setAgentId] = useState<string | undefined>(props.agentId ?? agents[0]?.id);
  const [conflictPolicy, setConflictPolicy] = useState<CloudHandoffConflictPolicy>("abort");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<CloudHandoffPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectPath.length === 0 && projects[0]?.workspaceRoot !== undefined) {
      setProjectPath(projects[0].workspaceRoot);
    }
  }, [projectPath, projects]);

  const selectedFiles = useMemo(
    () => preview?.files.filter((file) => selected.has(file.path)) ?? [],
    [preview, selected],
  );

  const loadPreview = async () => {
    if (projectPath.length === 0) {
      setMessage("Choose a local project before previewing a transfer.");
      return;
    }
    setBusy(true);
    const loaded = await previewCommand({
      environmentId: props.environmentId,
      input: {
        direction,
        intent,
        localWorkspacePath: projectPath,
        sourceEnvironmentId: props.environmentId,
        destinationEnvironmentId: props.environmentId,
        ...(agentId === undefined ? {} : { agentId: CloudAgentId.make(agentId) }),
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(loaded)) {
      setPreview(loaded.value);
      setSelected(
        new Set(
          loaded.value.files
            .filter((file) => file.inclusion === "selected")
            .map((file) => file.path),
        ),
      );
      setMessage(null);
      return;
    }
    setPreview(null);
    setMessage("The controller could not preview this transfer.");
  };

  const runTransfer = async () => {
    if (preview === null || preview.destination.workspacePath === undefined) {
      setMessage("Preview the transfer before applying it.");
      return;
    }
    setBusy(true);
    const result = await executeCommand({
      environmentId: props.environmentId,
      input: {
        transferId: preview.transferId,
        direction,
        intent,
        localWorkspacePath: projectPath,
        sourceEnvironmentId: props.environmentId,
        destinationEnvironmentId: props.environmentId,
        destinationWorkspacePath: preview.destination.workspacePath,
        selectedPaths: [...selected],
        conflictPolicy,
        ...(agentId === undefined ? {} : { agentId: CloudAgentId.make(agentId) }),
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setMessage(cloudHandoffResultSummary(result.value));
      return;
    }
    setMessage("The controller refused this transfer. Dirty local files were left untouched.");
  };

  return (
    <section className="flex flex-col gap-4" data-testid="cloud-handoff">
      <div>
        <h2 className="text-sm font-medium">Local / cloud handoff</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Preview selected files before they move. Credentials and ignored files stay out unless you
          name an ignored path explicitly. Wake continues the same agent; a linked continuation gets
          its own environment identity.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Direction
          <select
            className={selectClassName}
            value={direction}
            onChange={(event) => setDirection(event.target.value as CloudHandoffDirection)}
          >
            <option value="local-to-cloud">Local to cloud</option>
            <option value="cloud-to-local">Cloud to local</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Intent
          <select
            className={selectClassName}
            value={intent}
            onChange={(event) => setIntent(event.target.value as CloudHandoffIntent)}
          >
            <option value="linked-continuation">
              {cloudHandoffIntentLabel("linked-continuation")}
            </option>
            <option value="wake-same-agent">{cloudHandoffIntentLabel("wake-same-agent")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Local project
          <select
            className={selectClassName}
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.workspaceRoot}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Cloud agent
          <select
            className={selectClassName}
            value={agentId ?? ""}
            onChange={(event) =>
              setAgentId(event.target.value === "" ? undefined : event.target.value)
            }
          >
            <option value="">None</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.conversation.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Dirty files
          <select
            className={selectClassName}
            value={conflictPolicy}
            onChange={(event) =>
              setConflictPolicy(event.target.value as CloudHandoffConflictPolicy)
            }
          >
            <option value="abort">Abort on conflict</option>
            <option value="skip-conflicting">Skip conflicting files</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadPreview()}>
          Preview transfer
        </Button>
        <Button size="sm" disabled={busy || preview === null} onClick={() => void runTransfer()}>
          Apply transfer
        </Button>
      </div>
      {preview === null ? null : (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Base {preview.baseCommit.slice(0, 12)}
            {preview.baseBranch === undefined ? "" : ` on ${preview.baseBranch}`} · destination{" "}
            {preview.destination.workspacePath ??
              preview.destination.agentId ??
              preview.destination.surface}
          </p>
          <p className="text-muted-foreground">{preview.explanation}</p>
          <p className="text-muted-foreground">{preview.history.description}</p>
          <p>{cloudHandoffSelectedCount(preview)} file(s) selected by default.</p>
          <ul className="max-h-48 overflow-auto rounded-lg bg-muted/40 p-3 text-xs">
            {preview.files.map((file) => (
              <li key={file.path} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(file.path)}
                  disabled={file.excludeReason === "credential"}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    setSelected(next);
                  }}
                />
                <span>{cloudHandoffFileLabel(file)}</span>
              </li>
            ))}
          </ul>
          {selectedFiles.length === 0 && intent === "linked-continuation" ? (
            <p className="text-muted-foreground">No files are selected to copy.</p>
          ) : null}
        </div>
      )}
      {message === null ? null : <p className="text-sm">{message}</p>}
    </section>
  );
}
