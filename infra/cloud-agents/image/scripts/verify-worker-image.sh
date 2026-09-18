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
command -v aws >/dev/null || fail "AWS CLI is unavailable for provider authentication"
[[ "$(stat --format '%U:%G:%a' /var/lib/t3-worker/t3)" == "cloudagent:cloudagent:700" ]] \
  || fail "T3 state permissions are not isolated"
[[ "$(stat --format '%U:%G:%a' /work)" == "cloudagent:cloudagent:750" ]] \
  || fail "workspace permissions are not isolated"
[[ "$(systemctl is-enabled cloud-agent-worker.service)" == "enabled" ]] \
  || fail "worker service is not enabled"
[[ "$(systemctl is-enabled cloud-agent-worker-registration.service)" == "enabled" ]] \
  || fail "worker registration service is not enabled"

systemd-analyze verify /etc/systemd/system/cloud-agent-worker.service
systemd-analyze verify /etc/systemd/system/cloud-agent-worker-registration.service
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
systemctl enable cloud-agent-worker.service
systemctl enable cloud-agent-worker-registration.service
