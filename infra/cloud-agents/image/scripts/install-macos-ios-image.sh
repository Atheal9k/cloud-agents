#!/bin/bash
set -euo pipefail

# Authorized macOS iOS worker image. Run this on an EC2 Mac that an operator
# has already logged into, accepted the Xcode license on, and installed the
# pinned Xcode + simulator runtime. It does not click through license dialogs
# unattended.

: "${IMAGE_VERSION:?IMAGE_VERSION is required}"
: "${MACOS_VERSION:?MACOS_VERSION is required}"
: "${PROFILE_NAME:?PROFILE_NAME is required}"
: "${SIMULATOR_RUNTIME:?SIMULATOR_RUNTIME is required}"
: "${T3_VERSION:?T3_VERSION is required}"
: "${XCODE_VERSION:?XCODE_VERSION is required}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-macos-ios-image.sh must run on macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "macos-ios images require Apple Silicon." >&2
  exit 1
fi

xcodebuild -checkFirstLaunchStatus
xcodebuild -license check
xcrun simctl list runtimes | grep -F "${SIMULATOR_RUNTIME}" >/dev/null

dscl . -read /Users/cloudagent >/dev/null 2>&1 || \
  sysadminctl -addUser cloudagent -fullName "Cloud Agent" -password - -admin

install -d -o cloudagent -g staff -m 0755 /opt/t3
install -d -o cloudagent -g staff -m 0755 /opt/t3/bin
install -d -o cloudagent -g staff -m 0755 /work
install -d -o cloudagent -g staff -m 0755 /var/lib/t3-worker

cat > /opt/t3/worker-image-manifest.json <<JSON
{
  "profile": "${PROFILE_NAME}",
  "imageVersion": "${IMAGE_VERSION}",
  "macos": "${MACOS_VERSION}",
  "xcode": "${XCODE_VERSION}",
  "simulatorRuntime": "${SIMULATOR_RUNTIME}",
  "t3Version": "${T3_VERSION}",
  "architecture": "arm64"
}
JSON

install -m 0755 "$(dirname "$0")/cloud-agent-ios-simulator-job" /opt/t3/bin/cloud-agent-ios-simulator-job
install -m 0755 "$(dirname "$0")/cloud-agent-ios-job-cleanup" /opt/t3/bin/cloud-agent-ios-job-cleanup
