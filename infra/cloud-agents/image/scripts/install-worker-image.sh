#!/bin/bash
set -euo pipefail

: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION is required}"
: "${CODEX_VERSION:?CODEX_VERSION is required}"
: "${DCV_ARCHIVE_SHA256:?DCV_ARCHIVE_SHA256 is required}"
: "${DCV_GPG_KEY_SHA256:?DCV_GPG_KEY_SHA256 is required}"
: "${DCV_VERSION:?DCV_VERSION is required}"
: "${IMAGE_VERSION:?IMAGE_VERSION is required}"
: "${INSTALL_DESKTOP_DEPENDENCIES:?INSTALL_DESKTOP_DEPENDENCIES is required}"
: "${INSTALL_SHARED_BROWSER:?INSTALL_SHARED_BROWSER is required}"
: "${NODE_LINUX_X64_SHA256:?NODE_LINUX_X64_SHA256 is required}"
: "${NODE_VERSION:?NODE_VERSION is required}"
: "${PROFILE_NAME:?PROFILE_NAME is required}"
: "${SOURCE_AMI_ID:?SOURCE_AMI_ID is required}"
: "${T3_VERSION:?T3_VERSION is required}"
: "${TAILSCALE_VERSION:?TAILSCALE_VERSION is required}"

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

dnf install --assumeyes dnf-plugins-core
dnf config-manager --add-repo https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo
dnf install --assumeyes "tailscale-${TAILSCALE_VERSION}"
systemctl disable --now tailscaled.service || true
install -d -o root -g root -m 0700 /var/lib/tailscale
find /var/lib/tailscale -mindepth 1 -delete

install -d -m 0755 /opt/t3/bin

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

if [[ "${INSTALL_SHARED_BROWSER}" == "true" ]]; then
  [[ "${INSTALL_DESKTOP_DEPENDENCIES}" == "true" ]] \
    || { echo "shared browser requires desktop dependencies" >&2; exit 1; }
  dnf install --assumeyes spal-release
  dnf install --assumeyes chromium nginx
  chromium_executable="$(command -v chromium-browser)" \
    || { echo "SPAL Chromium executable is unavailable" >&2; exit 1; }
  ln --symbolic "${chromium_executable}" /usr/local/bin/chromium

  dcv_archive="nice-dcv-${DCV_VERSION}-amzn2023-x86_64.tgz"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output /tmp/NICE-GPG-KEY \
    "https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY"
  echo "${DCV_GPG_KEY_SHA256}  /tmp/NICE-GPG-KEY" | sha256sum --check --strict
  rpm --import /tmp/NICE-GPG-KEY
  rm -f /tmp/NICE-GPG-KEY
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "/tmp/${dcv_archive}" \
    "https://d1uj6qtbmh3dt5.cloudfront.net/2025.0/Servers/${dcv_archive}"
  echo "${DCV_ARCHIVE_SHA256}  /tmp/${dcv_archive}" | sha256sum --check --strict
  install -d -m 0755 /tmp/dcv-packages
  tar --extract --file "/tmp/${dcv_archive}" --directory /tmp/dcv-packages --strip-components 1
  dnf install --assumeyes \
    /tmp/dcv-packages/nice-dcv-server-*.rpm \
    /tmp/dcv-packages/nice-dcv-web-viewer-*.rpm \
    /tmp/dcv-packages/nice-xdcv-*.rpm
  rm -rf /tmp/dcv-packages "/tmp/${dcv_archive}"

  install -m 0644 /tmp/dcv.conf /etc/dcv/dcv.conf
  install -m 0644 /tmp/shared-browser.perm /etc/dcv/shared-browser.perm
  install -m 0644 /tmp/shared-browser-control.perm /etc/dcv/shared-browser-control.perm
  install -m 0644 /tmp/shared-browser-nginx.conf /etc/nginx/conf.d/t3-shared-browser.conf
  install -m 0755 /tmp/cloud-agent-shared-browser /opt/t3/bin/cloud-agent-shared-browser
  install -m 0755 /tmp/cloud-agent-shared-browser-session \
    /opt/t3/bin/cloud-agent-shared-browser-session
  install -m 0755 /tmp/cloud-agent-shared-browser-permissions \
    /opt/t3/bin/cloud-agent-shared-browser-permissions
  install -m 0755 /tmp/measure-shared-browser.sh /opt/t3/bin/measure-shared-browser
  systemctl enable dcvserver.service nginx.service
fi
rm -f \
  /tmp/dcv.conf \
  /tmp/shared-browser.perm \
  /tmp/shared-browser-control.perm \
  /tmp/shared-browser-nginx.conf \
  /tmp/cloud-agent-shared-browser \
  /tmp/cloud-agent-shared-browser-session \
  /tmp/cloud-agent-shared-browser-permissions \
  /tmp/measure-shared-browser.sh

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

install -d -o cloudagent -g cloudagent -m 0700 /var/lib/t3-worker/t3
install -d -o cloudagent -g cloudagent -m 0750 /work
install -d -o root -g cloudagent -m 0750 /etc/t3
install -m 0755 /tmp/cloud-agent-worker-preflight /opt/t3/bin/cloud-agent-worker-preflight
install -m 0755 /tmp/cloud-agent-worker-register /opt/t3/bin/cloud-agent-worker-register
install -m 0755 /tmp/cloud-agent-worker-cleanup /opt/t3/bin/cloud-agent-worker-cleanup
install -m 0755 /tmp/cloud-agent-codex-auth-sync /opt/t3/bin/cloud-agent-codex-auth-sync
install -m 0644 /tmp/cloud-agent-worker.service /etc/systemd/system/cloud-agent-worker.service
install -m 0644 /tmp/cloud-agent-worker-registration.service /etc/systemd/system/cloud-agent-worker-registration.service
install -m 0644 /tmp/cloud-agent-codex-auth-sync.service /etc/systemd/system/cloud-agent-codex-auth-sync.service
install -m 0644 /tmp/cloud-agent-codex-auth-sync.path /etc/systemd/system/cloud-agent-codex-auth-sync.path
install -m 0644 /tmp/cloud-agent-codex-auth-sync.timer /etc/systemd/system/cloud-agent-codex-auth-sync.timer

jq --null-input \
  --arg image_version "${IMAGE_VERSION}" \
  --arg profile "${PROFILE_NAME}" \
  --arg source_ami_id "${SOURCE_AMI_ID}" \
  --arg node "${NODE_VERSION}" \
  --arg t3 "${T3_VERSION}" \
  --arg claude_code "${CLAUDE_CODE_VERSION}" \
  --arg codex "${CODEX_VERSION}" \
  --arg tailscale "${TAILSCALE_VERSION}" \
  --argjson desktop_dependencies "${INSTALL_DESKTOP_DEPENDENCIES}" \
  --argjson shared_browser "${INSTALL_SHARED_BROWSER}" \
  --arg dcv "${DCV_VERSION}" \
  '{
    imageVersion: $image_version,
    profile: $profile,
    sourceAmiId: $source_ami_id,
    runtime: {
      node: $node,
      t3: $t3,
      claudeCode: $claude_code,
      codex: $codex,
      tailscale: $tailscale,
      dcv: (if $shared_browser then $dcv else null end)
    },
    capabilities: {
      coding: true,
      webPreview: true,
      desktopDependencies: $desktop_dependencies,
      mobileSdk: false,
      desktopStreamService: $shared_browser,
      browserAutomation: $shared_browser,
      desktopStreamTransport: (if $shared_browser then "dcv" else null end)
    }
  }' >/opt/t3/worker-image-manifest.json
chmod 0644 /opt/t3/worker-image-manifest.json

rpm --query --all | sort >/opt/t3/worker-os-packages.txt
chmod 0644 /opt/t3/worker-os-packages.txt

systemctl daemon-reload
systemctl enable cloud-agent-worker.service
systemctl enable cloud-agent-worker-registration.service
