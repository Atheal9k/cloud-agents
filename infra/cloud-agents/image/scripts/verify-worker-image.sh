#!/bin/bash
set -euo pipefail

fail() {
  echo "worker image verification failed: $*" >&2
  exit 1
}

[[ "$(node --version)" == "v${NODE_VERSION}" ]] || fail "Node.js version does not match"
[[ "$(t3 --version)" == *"${T3_VERSION}"* ]] || fail "T3 version does not match"
[[ "$(codex --version)" == *"${CODEX_VERSION}"* ]] || fail "Codex version does not match"
[[ "$(stat --format '%U:%G:%a' /var/lib/t3-worker/t3)" == "cloudagent:cloudagent:700" ]] \
  || fail "T3 state permissions are not isolated"
[[ "$(stat --format '%U:%G:%a' /work)" == "cloudagent:cloudagent:750" ]] \
  || fail "workspace permissions are not isolated"
[[ "$(systemctl is-enabled cloud-agent-worker.service)" == "enabled" ]] \
  || fail "worker service is not enabled"

systemd-analyze verify /etc/systemd/system/cloud-agent-worker.service
install -d -m 0750 /etc/t3
cat >/etc/t3/worker.env <<'ENV'
T3CODE_PORT=3773
T3_WORKER_IMAGE_VERSION=image-build-verification
T3_WORKER_PROFILE=image-build-verification
ENV
chown root:cloudagent /etc/t3/worker.env
chmod 0640 /etc/t3/worker.env
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

service_uid="$(id -u cloudagent)"
main_pid="$(systemctl show --property MainPID --value cloud-agent-worker.service)"
[[ "$(stat --format '%u' "/proc/${main_pid}")" == "${service_uid}" ]] \
  || fail "worker service is not running as cloudagent"

systemctl stop cloud-agent-worker.service
rm -f /etc/t3/worker.env
[[ ! -e /run/t3-worker/credentials ]] \
  || [[ -z "$(find /run/t3-worker/credentials -mindepth 1 -print -quit)" ]] \
  || fail "temporary credentials remained after service stop"
find /var/lib/t3-worker/t3 -mindepth 1 -delete
[[ -z "$(find /var/lib/t3-worker/t3 -mindepth 1 -print -quit)" ]] \
  || fail "bake-time T3 identity or state remained in the image"

for command in adb emulator xcodebuild dcvserver; do
  if command -v "${command}" >/dev/null 2>&1; then
    fail "unexpected mobile or desktop-stream command is installed: ${command}"
  fi
done

if [[ "${INSTALL_DESKTOP_DEPENDENCIES}" == "true" ]]; then
  command -v Xvfb >/dev/null || fail "desktop profile is missing Xvfb"
else
  command -v Xvfb >/dev/null && fail "headless profile contains desktop dependencies"
fi

systemctl enable cloud-agent-worker.service
