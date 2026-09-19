# Linux Android emulator worker image

Build this AMI with nested virtualization in mind. The web worker `t3.medium`
cannot accelerate the emulator. Use an AWS instance type that supports the
`NestedVirtualization=enabled` CPU option, such as `m7i.xlarge`, then prove
`/dev/kvm` and `emulator -accel-check` on the running instance before a Gradle
build.

```powershell
packer build `
  -var "source_ami_id=ami-0123456789abcdef0" `
  -var "profile_name=linux-android" `
  -var "image_version=0.0.42-ca37.1" `
  -var "install_android_sdk=true" `
  -var "android_cmdline_tools_sha256=<sha256 of the pinned cmdline-tools zip>" `
  ./image
```

Copy the AMI ID into `worker_profiles.linux-android`. The controller enables
nested virtualization at `RunInstances` and rejects `t3` types. Each job copies
the template AVD under `/var/lib/t3-worker/android/<allocation>/<attempt>`,
targets one `emulator-<port>` serial, and binds ADB to loopback. Expo Go is not
accepted as native-module proof; native fingerprint changes rebuild the debug
client.

Hibernation snapshots AVD data separately from the environment Build. If that
directory is missing on wake, the worker creates a new AVD and reports that app
and login state did not persist.

Live emulator display in the thread is CA-39.
