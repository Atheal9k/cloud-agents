#!/bin/bash
set -euo pipefail

# Pin JDK 17, cmdline-tools, platform-tools, build-tools, emulator, and one
# Google APIs system image. The template AVD is copied per job; it is not a
# shared writable emulator.

: "${ANDROID_API_LEVEL:?ANDROID_API_LEVEL is required}"
: "${ANDROID_ABI:?ANDROID_ABI is required}"
: "${ANDROID_BUILD_TOOLS:?ANDROID_BUILD_TOOLS is required}"
: "${ANDROID_CMDLINE_TOOLS_VERSION:?ANDROID_CMDLINE_TOOLS_VERSION is required}"
: "${ANDROID_CMDLINE_TOOLS_SHA256:?ANDROID_CMDLINE_TOOLS_SHA256 is required}"

sdk_root=/opt/android-sdk
avd_home=/opt/android-sdk/avd-template
install -d -m 0755 "${sdk_root}" "${avd_home}" "${sdk_root}/cmdline-tools"

dnf install --assumeyes java-17-amazon-corretto-devel unzip

cmdline_archive="commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "/tmp/${cmdline_archive}" \
  "https://dl.google.com/android/repository/${cmdline_archive}"
echo "${ANDROID_CMDLINE_TOOLS_SHA256}  /tmp/${cmdline_archive}" | sha256sum --check --strict
unzip -q "/tmp/${cmdline_archive}" -d "${sdk_root}/cmdline-tools"
mv "${sdk_root}/cmdline-tools/cmdline-tools" "${sdk_root}/cmdline-tools/latest"
rm -f "/tmp/${cmdline_archive}"

export ANDROID_HOME="${sdk_root}"
export ANDROID_SDK_ROOT="${sdk_root}"
export JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto
PATH="${sdk_root}/cmdline-tools/latest/bin:${sdk_root}/platform-tools:${sdk_root}/emulator:${PATH}"

yes | sdkmanager --sdk_root="${sdk_root}" --licenses >/dev/null
sdkmanager --sdk_root="${sdk_root}" --install \
  "platform-tools" \
  "emulator" \
  "build-tools;${ANDROID_BUILD_TOOLS}" \
  "platforms;android-${ANDROID_API_LEVEL}" \
  "system-images;android-${ANDROID_API_LEVEL};google_apis;${ANDROID_ABI}"

echo "hw.keyboard=yes" > /tmp/t3-android-avd.ini
avdmanager create avd \
  --force \
  --name t3-android-template \
  --package "system-images;android-${ANDROID_API_LEVEL};google_apis;${ANDROID_ABI}" \
  --path "${avd_home}/t3-android-template" \
  --device pixel_7

install -d -o cloudagent -g cloudagent -m 0750 /var/lib/t3-worker/android
chown -R cloudagent:cloudagent "${sdk_root}" "${avd_home}"

cat >/etc/profile.d/t3-android-sdk.sh <<'ENV'
export JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
ENV
chmod 0644 /etc/profile.d/t3-android-sdk.sh
