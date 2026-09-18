#!/bin/bash
set -euo pipefail

fail() {
  echo "worker image verification failed: $*" >&2
  exit 1
}

[[ "$(node --version)" == "v${NODE_VERSION}" ]] || fail "Node.js version does not match"
[[ "$(t3 --version)" == *"${T3_VERSION}"* ]] || fail "T3 version does not match"
[[ "$(claude --version)" == *"${CLAUDE_CODE_VERSION}"* ]] || fail "Claude Code version does not match"
[[ "$(codex --version)" == *"${CODEX_VERSION}"* ]] || fail "Codex version does not match"
[[ "$(gh --version | head -n 1)" == "gh version ${GITHUB_CLI_VERSION} "* ]] \
  || fail "GitHub CLI version does not match"
[[ "$(tailscale version | head -n 1)" == "${TAILSCALE_VERSION}" ]] \
  || fail "Tailscale version does not match"
command -v docker >/dev/null || fail "Docker CLI is unavailable"
[[ "$(docker compose version --short)" == "${DOCKER_COMPOSE_VERSION}" ]] \
  || fail "Docker Compose version does not match"
command -v doppler >/dev/null || fail "Doppler CLI is unavailable"
command -v aws >/dev/null || fail "AWS CLI is unavailable for provider authentication"
command -v tailscaled >/dev/null || fail "Tailscale daemon is unavailable"
[[ -x /opt/t3/bin/cloud-agent-github-credentials ]] \
  || fail "GitHub credential installer is unavailable"
[[ -x /opt/t3/bin/cloud-agent-prepare-repository ]] \
  || fail "repository preparation command is unavailable"
[[ "$(systemctl is-enabled tailscaled.service 2>/dev/null || true)" == "disabled" ]] \
  || fail "Tailscale must remain disabled until worker bootstrap"
[[ "$(systemctl is-enabled docker.service 2>/dev/null || true)" == "enabled" ]] \
  || fail "Docker service is not enabled"
id --groups --name cloudagent | tr ' ' '\n' | grep --fixed-strings --line-regexp docker >/dev/null \
  || fail "cloudagent is not a member of the docker group"
systemctl start docker.service
sudo -u cloudagent docker info >/dev/null \
  || fail "cloudagent cannot use the Docker daemon"
systemctl is-active --quiet tailscaled.service && fail "Tailscale is active in the baked image"
[[ -z "$(find /var/lib/tailscale -mindepth 1 -print -quit)" ]] \
  || fail "Tailscale identity remained in the image"
[[ "$(stat --format '%U:%G:%a' /var/lib/t3-worker/t3)" == "cloudagent:cloudagent:700" ]] \
  || fail "T3 state permissions are not isolated"
[[ "$(stat --format '%U:%G:%a' /work)" == "cloudagent:cloudagent:750" ]] \
  || fail "workspace permissions are not isolated"
[[ "$(systemctl is-enabled cloud-agent-worker.service 2>/dev/null || true)" == "disabled" ]] \
  || fail "worker service must remain disabled until cloud-init finishes"
[[ "$(systemctl is-enabled cloud-agent-worker-registration.service 2>/dev/null || true)" == "disabled" ]] \
  || fail "worker registration must remain disabled until routing is ready"

systemd-analyze verify /etc/systemd/system/cloud-agent-worker.service
systemd-analyze verify /etc/systemd/system/cloud-agent-worker-registration.service
systemd-analyze verify /etc/systemd/system/cloud-agent-codex-auth-sync.service
systemd-analyze verify /etc/systemd/system/cloud-agent-codex-auth-sync.path
systemd-analyze verify /etc/systemd/system/cloud-agent-codex-auth-sync.timer
[[ "$(systemctl show --property User --value cloud-agent-worker-registration.service)" == "cloudagent" ]] \
  || fail "worker registration does not run as cloudagent"
install -d -o root -g cloudagent -m 0750 /etc/t3
cat >/etc/t3/worker.env <<'ENV'
T3CODE_PORT=3773
T3CODE_SHARED_BROWSER_ATTEMPT_KEY=image-build:1
T3CODE_SHARED_BROWSER_THREAD_ID=image-build-verification
T3_WORKER_IMAGE_VERSION=image-build-verification
T3_WORKER_PROFILE=image-build-verification
ENV
chown root:cloudagent /etc/t3/worker.env
chmod 0640 /etc/t3/worker.env
install -d -o cloudagent -g cloudagent -m 0700 \
  /run/t3-worker/credentials/claude \
  /run/t3-worker/credentials/codex
cat >/run/t3-worker/runtime.env <<'ENV'
CLAUDE_CODE_OAUTH_TOKEN='image-build-fixture'
GH_TOKEN='image-build-fixture'
GITHUB_TOKEN='image-build-fixture'
ENV
cat >/run/t3-worker/credentials/codex/auth.json <<'JSON'
{"auth_mode":"chatgpt","tokens":{"refresh_token":"image-build-fixture"}}
JSON
cat >/run/t3-worker/credentials/codex/config.toml <<'TOML'
cli_auth_credentials_store = "file"
TOML
chown root:cloudagent /run/t3-worker/runtime.env
chown -R cloudagent:cloudagent /run/t3-worker/credentials
chmod 0640 /run/t3-worker/runtime.env
chmod 0600 \
  /run/t3-worker/credentials/codex/auth.json \
  /run/t3-worker/credentials/codex/config.toml
sudo -u cloudagent test -r /etc/t3/worker.env \
  || fail "worker environment is not readable by cloudagent"
systemctl start cloud-agent-worker.service

for _ in {1..30}; do
  if curl --silent --show-error --fail --max-time 2 http://127.0.0.1:3773/ >/dev/null; then
    break
  fi
  sleep 1
done

systemctl is-active --quiet cloud-agent-worker.service \
  || fail "worker service did not stay active: $(systemctl status cloud-agent-worker.service --no-pager)"
curl --silent --show-error --fail --max-time 2 http://127.0.0.1:3773/ >/dev/null \
  || fail "worker HTTP endpoint is unavailable"
[[ "$(stat --format '%U:%G:%a' /var/cache/t3-worker-dependencies)" == "cloudagent:cloudagent:700" ]] \
  || fail "dependency cache permissions are not isolated"

service_uid="$(id -u cloudagent)"
main_pid="$(systemctl show --property MainPID --value cloud-agent-worker.service)"
[[ "$(stat --format '%u' "/proc/${main_pid}")" == "${service_uid}" ]] \
  || fail "worker service is not running as cloudagent"
registration_token="$(sudo -u cloudagent env HOME=/home/cloudagent \
  t3 auth session issue \
  --base-dir /var/lib/t3-worker/t3 \
  --ttl 5m \
  --subject worker-image-verification \
  --label 'Worker image verification' \
  --token-only)" \
  || fail "worker registration token could not be issued as cloudagent"
[[ -n "${registration_token}" ]] || fail "worker registration token is empty"
unset registration_token

systemctl stop cloud-agent-worker.service
[[ ! -e /run/t3-worker/credentials ]] \
  || [[ -z "$(find /run/t3-worker/credentials -mindepth 1 -print -quit)" ]] \
  || fail "temporary credentials remained after service stop"
find /var/lib/t3-worker/t3 -mindepth 1 -delete
[[ -z "$(find /var/lib/t3-worker/t3 -mindepth 1 -print -quit)" ]] \
  || fail "bake-time T3 identity or state remained in the image"

for command in adb emulator xcodebuild; do
  if command -v "${command}" >/dev/null 2>&1; then
    fail "unexpected mobile or desktop-stream command is installed: ${command}"
  fi
done

if [[ "${INSTALL_DESKTOP_DEPENDENCIES}" == "true" ]]; then
  command -v Xvfb >/dev/null || fail "desktop profile is missing Xvfb"
else
  command -v Xvfb >/dev/null && fail "headless profile contains desktop dependencies"
fi

if [[ "${INSTALL_SHARED_BROWSER}" == "true" ]]; then
  command -v chromium >/dev/null || fail "shared-browser profile is missing Chromium"
  command -v dcvserver >/dev/null || fail "shared-browser profile is missing Amazon DCV"
  [[ "$(dcv version)" == *"${DCV_VERSION%%-*}"* ]] || fail "Amazon DCV version does not match"
  [[ "$(systemctl is-enabled dcvserver.service)" == "enabled" ]] \
    || fail "Amazon DCV service is not enabled"
  [[ "$(systemctl is-enabled nginx.service)" == "enabled" ]] \
    || fail "shared-browser proxy is not enabled"
  systemctl restart dcvserver.service nginx.service
  sleep 2
  systemctl is-active --quiet dcvserver.service \
    || fail "Amazon DCV service did not stay active"
  systemctl is-active --quiet nginx.service \
    || fail "shared-browser proxy did not stay active"
  ss -H -ltn | awk '$4 == "127.0.0.1:8443" { found = 1 } END { exit !found }' \
    || fail "Amazon DCV is not listening on loopback"
  ss -H -ltn | awk '$4 == "127.0.0.1:8090" { found = 1 } END { exit !found }' \
    || fail "shared-browser proxy is not listening on loopback"
  ss -H -lun | awk '$4 ~ /:8443$/ { found = 1 } END { exit found }' \
    || fail "Amazon DCV unexpectedly exposes QUIC"
  [[ -z "$(sudo -u cloudagent dcv list-sessions)" ]] \
    || fail "worker image contains a running desktop session"
  install -d -o cloudagent -g cloudagent -m 0700 /run/t3-worker
  browser_descriptor="$(sudo -u cloudagent /opt/t3/bin/cloud-agent-shared-browser)" \
    || fail "shared-browser lifecycle helper failed"
  jq --exit-status \
    '.sessionId == "t3-image-build-1" and
     (.display | type == "string" and length > 0) and
     (.xAuthority | type == "string" and length > 0)' \
    <<<"${browser_descriptor}" >/dev/null \
    || fail "shared-browser lifecycle helper returned an invalid descriptor"
  sudo -u cloudagent /opt/t3/bin/cloud-agent-shared-browser-permissions human \
    || fail "shared-browser input permissions could not be granted"
  sudo -u cloudagent /opt/t3/bin/cloud-agent-shared-browser-permissions agent \
    || fail "shared-browser input permissions could not be revoked"
  sudo -u cloudagent dcv close-session t3-image-build-1
  [[ -z "$(sudo -u cloudagent dcv list-sessions)" ]] \
    || fail "shared-browser verification session remained open"
else
  command -v dcvserver >/dev/null && fail "headless profile contains Amazon DCV"
fi

rm -f /etc/t3/worker.env
systemctl disable cloud-agent-worker.service cloud-agent-worker-registration.service
