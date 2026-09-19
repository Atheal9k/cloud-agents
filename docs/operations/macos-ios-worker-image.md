# macOS iOS worker image

Build this image on an authorized Apple Silicon EC2 Mac. The operator must
complete macOS first login, Xcode license acceptance, and simulator runtime
installation before the script runs. The script checks those steps; it does
not click through licenses.

1. Allocate a Mac Dedicated Host in a supported region (not `us-west-1`).
2. Launch the AWS macOS AMI onto that host and complete Setup Assistant.
3. Install the pinned Xcode and matching iOS Simulator runtime.
4. Run `sudo xcodebuild -license accept` only with authorization to accept
   Apple's license for this account.
5. Create the `cloudagent` user if needed, then run:

```sh
sudo IMAGE_VERSION=0.0.42-ca38.1 \
  MACOS_VERSION=15.6 \
  PROFILE_NAME=macos-ios \
  SIMULATOR_RUNTIME="iOS 18.5" \
  T3_VERSION=0.0.42 \
  XCODE_VERSION=16.4 \
  infra/cloud-agents/image/scripts/install-macos-ios-image.sh
```

6. Create an AMI from the instance. Put that AMI ID in `mac_worker_profiles`.
7. Jobs reserve a Simulator UDID with `/opt/t3/bin/cloud-agent-ios-simulator-job`
   and clean that UDID with `/opt/t3/bin/cloud-agent-ios-job-cleanup`. Cancelling
   a job does not release the Dedicated Host.

Live Simulator display in the thread is served through serve-sim on loopback
and the worker's `/api/device-display` route. Linux DCV is not used. The
thread preview selects the iOS device for this profile. The image still needs
a console session so `simctl` can boot, screenshot, and install.
