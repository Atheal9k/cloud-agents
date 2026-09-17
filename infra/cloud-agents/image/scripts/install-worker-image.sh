#!/bin/bash
set -euo pipefail

: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION is required}"
: "${CODEX_VERSION:?CODEX_VERSION is required}"
: "${IMAGE_VERSION:?IMAGE_VERSION is required}"
: "${INSTALL_DESKTOP_DEPENDENCIES:?INSTALL_DESKTOP_DEPENDENCIES is required}"
: "${NODE_LINUX_X64_SHA256:?NODE_LINUX_X64_SHA256 is required}"
: "${NODE_VERSION:?NODE_VERSION is required}"
: "${PROFILE_NAME:?PROFILE_NAME is required}"
: "${SOURCE_AMI_ID:?SOURCE_AMI_ID is required}"
: "${T3_VERSION:?T3_VERSION is required}"

dnf install --assumeyes \
  ca-certificates \
  curl-minimal \
  gcc-c++ \
  git \
  git-lfs \
  jq \
  libatomic \
  make \
  python3 \
  tar \
  xz

if [[ "${INSTALL_DESKTOP_DEPENDENCIES}" == "true" ]]; then
  dnf install --assumeyes \
    alsa-lib \
    at-spi2-atk \
    gtk3 \
    libXcomposite \
    libXdamage \
    libXrandr \
    mesa-libgbm \
    pango \
    xorg-x11-server-Xvfb
fi

node_archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "/tmp/${node_archive}" \
  "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"
echo "${NODE_LINUX_X64_SHA256}  /tmp/${node_archive}" | sha256sum --check --strict
tar --extract --file "/tmp/${node_archive}" --directory /usr/local --strip-components 1
rm -f "/tmp/${node_archive}"

npm install --global --omit=dev --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "t3@${T3_VERSION}"
npm cache clean --force

getent group cloudagent >/dev/null || groupadd --system cloudagent
if ! id cloudagent >/dev/null 2>&1; then
  useradd --system --gid cloudagent --create-home --home-dir /home/cloudagent --shell /bin/bash cloudagent
fi

install -d -m 0755 /opt/t3/bin
install -d -o cloudagent -g cloudagent -m 0700 /var/lib/t3-worker/t3
install -d -o cloudagent -g cloudagent -m 0750 /work
install -m 0755 /tmp/cloud-agent-worker-preflight /opt/t3/bin/cloud-agent-worker-preflight
install -m 0755 /tmp/cloud-agent-worker-register /opt/t3/bin/cloud-agent-worker-register
install -m 0755 /tmp/cloud-agent-worker-cleanup /opt/t3/bin/cloud-agent-worker-cleanup
install -m 0644 /tmp/cloud-agent-worker.service /etc/systemd/system/cloud-agent-worker.service
install -m 0644 /tmp/cloud-agent-worker-registration.service /etc/systemd/system/cloud-agent-worker-registration.service

jq --null-input \
  --arg image_version "${IMAGE_VERSION}" \
  --arg profile "${PROFILE_NAME}" \
  --arg source_ami_id "${SOURCE_AMI_ID}" \
  --arg node "${NODE_VERSION}" \
  --arg t3 "${T3_VERSION}" \
  --arg claude_code "${CLAUDE_CODE_VERSION}" \
  --arg codex "${CODEX_VERSION}" \
  --argjson desktop_dependencies "${INSTALL_DESKTOP_DEPENDENCIES}" \
  '{
    imageVersion: $image_version,
    profile: $profile,
    sourceAmiId: $source_ami_id,
    runtime: {
      node: $node,
      t3: $t3,
      claudeCode: $claude_code,
      codex: $codex
    },
    capabilities: {
      coding: true,
      webPreview: true,
      desktopDependencies: $desktop_dependencies,
      mobileSdk: false,
      desktopStreamService: false
    }
  }' >/opt/t3/worker-image-manifest.json
chmod 0644 /opt/t3/worker-image-manifest.json

rpm --query --all | sort >/opt/t3/worker-os-packages.txt
chmod 0644 /opt/t3/worker-os-packages.txt

systemctl daemon-reload
systemctl enable cloud-agent-worker.service
systemctl enable cloud-agent-worker-registration.service
