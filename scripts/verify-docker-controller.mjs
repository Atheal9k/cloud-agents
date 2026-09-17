import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const suffix = `${process.pid}-${Date.now()}`;
const project = `t3-controller-verify-${suffix}`;
const image = `t3-code-controller:verify-${suffix}`;
const volume = `t3-controller-verify-${suffix}`;
const helper = `t3-controller-backup-${suffix}`;
const restoreHelper = `t3-controller-restore-${suffix}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "t3-controller-verify-"));
const credentialsDirectory = join(temporaryDirectory, "credentials");
const backupPath = join(temporaryDirectory, "controller.tgz");
const sentinel = `docker-verification-${suffix}`;

mkdirSync(credentialsDirectory, { recursive: true });
writeFileSync(join(credentialsDirectory, "openai-api-key"), `${sentinel}\n`, { mode: 0o600 });

const capture = (args, options = {}) =>
  execFileSync("docker", args, {
    cwd: repository,
    encoding: "utf8",
    ...options,
  }).trim();

const run = (args) => {
  execFileSync("docker", args, { cwd: repository, stdio: "inherit" });
};

const runCleanup = (args) => {
  execFileSync("docker", args, { cwd: repository, stdio: "ignore" });
};

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Docker verification could not reserve a TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const port = await freePort();
const environment = {
  ...process.env,
  T3CODE_CREDENTIALS_DIR: credentialsDirectory.replaceAll("\\", "/"),
  T3CODE_DATA_VOLUME: volume,
  T3CODE_IMAGE: image,
  T3CODE_PORT: String(port),
  T3CODE_SOURCE_REVISION: revision,
};
const composeFiles = ["compose.yaml", "compose.build.yaml", "compose.credentials.yaml"];
const compose = [
  "compose",
  "--project-name",
  project,
  ...composeFiles.flatMap((file) => ["--file", file]),
];
const composeRun = (args, options = {}) =>
  execFileSync("docker", [...compose, ...args], {
    cwd: repository,
    env: environment,
    stdio: "inherit",
    ...options,
  });
const composeCapture = (args) =>
  execFileSync("docker", [...compose, ...args], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
  }).trim();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  composeRun(["build", "controller"]);
  composeRun(["up", "--detach", "--wait", "--wait-timeout", "180", "controller"]);

  const container = composeCapture(["ps", "--quiet", "controller"]);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const html = await response.text();
  assert(response.ok, `Controller returned HTTP ${response.status}.`);
  assert(/<script[^>]+src="\/assets\/.+\.js/.test(html), "Built web assets were not served.");
  assert(
    capture(["image", "inspect", image, "--format", "{{.Config.User}}"]),
    "The image has no configured runtime user.",
  );
  assert(
    capture(["image", "inspect", image, "--format", "{{.Config.User}}"]) === "10001:10001",
    "The controller image does not run as uid/gid 10001.",
  );
  assert(
    capture([
      "image",
      "inspect",
      image,
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ]) === revision,
    "The image revision label does not match the source commit.",
  );

  run([
    "exec",
    "--env",
    `EXPECTED=OPENAI_API_KEY=${sentinel}`,
    container,
    "sh",
    "-c",
    'for file in /proc/[0-9]*/environ; do tr "\\000" "\\n" < "$file" 2>/dev/null | grep -Fqx "$EXPECTED" && exit 0; done; exit 1',
  ]);

  capture([
    "exec",
    container,
    "node",
    "/opt/t3/dist/bin.mjs",
    "auth",
    "pairing",
    "create",
    "--label",
    "docker-verification",
    "--base-dir",
    "/var/lib/t3",
    "--json",
  ]);
  assert(
    capture([
      "exec",
      container,
      "node",
      "/opt/t3/dist/bin.mjs",
      "auth",
      "pairing",
      "list",
      "--base-dir",
      "/var/lib/t3",
      "--json",
    ]).includes("docker-verification"),
    "The durable pairing record was not written.",
  );

  composeRun(["restart", "controller"]);
  composeRun(["up", "--detach", "--wait", "--wait-timeout", "180", "controller"]);
  const restartedContainer = composeCapture(["ps", "--quiet", "controller"]);
  assert(
    capture([
      "exec",
      restartedContainer,
      "node",
      "/opt/t3/dist/bin.mjs",
      "auth",
      "pairing",
      "list",
      "--base-dir",
      "/var/lib/t3",
      "--json",
    ]).includes("docker-verification"),
    "The pairing record did not survive restart.",
  );

  composeRun(["stop", "controller"]);
  run([
    "create",
    "--name",
    helper,
    "--volume",
    `${volume}:/var/lib/t3`,
    "--entrypoint",
    "tar",
    image,
    "-C",
    "/var/lib/t3",
    "-czf",
    "/tmp/controller.tgz",
    ".",
  ]);
  run(["start", "--attach", helper]);
  run(["cp", `${helper}:/tmp/controller.tgz`, backupPath]);
  run(["rm", helper]);
  composeRun(["down"]);
  run(["volume", "rm", volume]);
  run(["volume", "create", volume]);

  run([
    "create",
    "--name",
    restoreHelper,
    "--volume",
    `${volume}:/var/lib/t3`,
    "--entrypoint",
    "tar",
    image,
    "-C",
    "/var/lib/t3",
    "-xzf",
    "/tmp/controller.tgz",
  ]);
  run(["cp", backupPath, `${restoreHelper}:/tmp/controller.tgz`]);
  run(["start", "--attach", restoreHelper]);
  run(["rm", restoreHelper]);

  composeRun(["up", "--detach", "--wait", "--wait-timeout", "180", "controller"]);
  const restoredContainer = composeCapture(["ps", "--quiet", "controller"]);
  assert(
    capture([
      "exec",
      restoredContainer,
      "node",
      "/opt/t3/dist/bin.mjs",
      "auth",
      "pairing",
      "list",
      "--base-dir",
      "/var/lib/t3",
      "--json",
    ]).includes("docker-verification"),
    "The pairing record did not survive backup and restore.",
  );

  console.log(`Verified controller image ${image} on http://127.0.0.1:${port}.`);
  console.log(
    "Verified built web serving, non-root runtime, protected credential loading, restart persistence, and cold backup/restore.",
  );
} finally {
  try {
    composeRun(["down", "--volumes", "--remove-orphans"]);
  } catch {}
  for (const container of [helper, restoreHelper]) {
    try {
      runCleanup(["rm", "--force", container]);
    } catch {}
  }
  try {
    runCleanup(["volume", "rm", volume]);
  } catch {}
  try {
    runCleanup(["image", "rm", image]);
  } catch {}
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
