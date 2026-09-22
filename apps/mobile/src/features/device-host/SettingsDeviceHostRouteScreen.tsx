import {
  androidDeviceHostIndicators,
  enrollAndroidDeviceHost,
  renameAndroidDeviceHost,
  revokeAndroidDeviceHost,
  setAndroidDeviceHostPaused,
  stopAndroidDeviceControl,
  type AndroidDeviceControlRuntime,
} from "@t3tools/client-runtime/android-device-host";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useDeviceHostEnrollment } from "./useDeviceHostEnrollment";

const INACTIVE_CONTROL: AndroidDeviceControlRuntime = { status: "inactive" };

function StatusRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0">
      <Text className="flex-1 text-base text-foreground">{props.label}</Text>
      <Text className="max-w-[190px] text-right text-sm text-foreground-muted">{props.value}</Text>
    </View>
  );
}

function permissionLabel(value: "not-requested" | "denied" | "granted"): string {
  switch (value) {
    case "not-requested":
      return "Not requested";
    case "denied":
      return "Denied";
    case "granted":
      return "Granted";
  }
}

export function SettingsDeviceHostRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { enrollment, loading, update } = useDeviceHostEnrollment();
  const [control, setControl] = useState<AndroidDeviceControlRuntime>(INACTIVE_CONTROL);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const connected = useMemo(
    () =>
      connectedEnvironments.filter((environment) => environment.connectionState === "connected"),
    [connectedEnvironments],
  );
  const effectiveEnvironmentId =
    enrollment.status === "enrolled"
      ? enrollment.environmentId
      : (selectedEnvironmentId ?? connected[0]?.environmentId ?? null);
  const name =
    nameDraft ??
    (enrollment.status === "enrolled"
      ? enrollment.name
      : (Device.deviceName ?? Device.modelName ?? "Android phone"));

  const indicators = androidDeviceHostIndicators({ enrollment, control });
  const selectedEnvironment = connected.find(
    (environment) => environment.environmentId === effectiveEnvironmentId,
  );

  const enroll = async () => {
    if (effectiveEnvironmentId === null) return;
    await update(
      enrollAndroidDeviceHost({
        platform: Platform.OS,
        deviceHostId: `android:${Crypto.randomUUID()}`,
        name,
        environmentId: effectiveEnvironmentId,
        now: new Date().toISOString(),
      }),
    );
  };

  const revoke = () => {
    Alert.alert(
      "Revoke this device host?",
      "This stops local broker authorization immediately, even if the Daytona sandbox or controller is offline.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            setControl(stopAndroidDeviceControl());
            setNameDraft(null);
            setSelectedEnvironmentId(null);
            void update(revokeAndroidDeviceHost());
          },
        },
      ],
    );
  };

  if (Platform.OS !== "android") {
    return (
      <View className="flex-1 bg-sheet">
        <ScrollView contentContainerClassName="px-5 py-8">
          <Text className="text-base text-foreground-muted">
            Device-host enrollment is available only in the Android client. Cloud agent review
            remains available on this device.
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <AndroidScreenHeader title="Android device host" onBack={() => navigation.goBack()} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3 rounded-[24px] bg-card px-5 py-5">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xl font-t3-bold text-foreground">This phone</Text>
            <StatusPill
              label={
                loading
                  ? "Loading"
                  : enrollment.status === "unenrolled"
                    ? "Not enrolled"
                    : enrollment.paused
                      ? "Paused"
                      : "Enrolled"
              }
              pillClassName={
                enrollment.status === "enrolled" && !enrollment.paused
                  ? "bg-success/15"
                  : "bg-subtle"
              }
              textClassName={
                enrollment.status === "enrolled" && !enrollment.paused
                  ? "text-success"
                  : "text-foreground-muted"
              }
            />
          </View>
          <Text className="text-sm leading-normal text-foreground-muted">
            Enrollment records which controller may ask this phone for device access. It does not
            enable screen capture, Accessibility, VPN, or wireless debugging.
          </Text>
        </View>

        {enrollment.status === "unenrolled" ? (
          <SettingsSection title="Enroll" card>
            <View className="gap-4 p-4">
              <TextInput
                accessibilityLabel="Device host name"
                className="rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
                onChangeText={setNameDraft}
                placeholder="Device name"
                placeholderTextColorClassName="text-foreground-muted"
                value={name}
              />
              <Text className="text-sm text-foreground-muted">Controller</Text>
              <View className="gap-2">
                {connected.map((environment) => {
                  const selected = environment.environmentId === effectiveEnvironmentId;
                  return (
                    <Pressable
                      key={environment.environmentId}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      className={
                        selected
                          ? "min-h-12 justify-center rounded-[16px] bg-primary px-4"
                          : "min-h-12 justify-center rounded-[16px] bg-subtle px-4"
                      }
                      onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Text
                        className={
                          selected
                            ? "font-t3-medium text-primary-foreground"
                            : "font-t3-medium text-foreground"
                        }
                      >
                        {environment.environmentLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {connected.length === 0 ? (
                <Text className="text-sm text-danger">Connect a controller before enrolling.</Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                className="min-h-12 items-center justify-center rounded-[16px] bg-primary px-4 disabled:opacity-40"
                disabled={effectiveEnvironmentId === null || loading}
                onPress={() => void enroll()}
              >
                <Text className="font-t3-bold text-primary-foreground">Enroll this phone</Text>
              </Pressable>
            </View>
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title="Enrollment" card>
              <View className="gap-3 p-4">
                <TextInput
                  accessibilityLabel="Device host name"
                  className="rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
                  onChangeText={setNameDraft}
                  value={name}
                />
                <Text className="text-sm text-foreground-muted">
                  Controller: {selectedEnvironment?.environmentLabel ?? enrollment.environmentId}
                </Text>
                <View className="flex-row gap-3">
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 flex-1 items-center justify-center rounded-[16px] bg-subtle px-4"
                    onPress={() => {
                      setNameDraft(null);
                      void update(renameAndroidDeviceHost(enrollment, name));
                    }}
                  >
                    <Text className="font-t3-bold text-foreground">Rename</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 flex-1 items-center justify-center rounded-[16px] bg-subtle px-4"
                    onPress={() =>
                      void update(setAndroidDeviceHostPaused(enrollment, !enrollment.paused))
                    }
                  >
                    <Text className="font-t3-bold text-foreground">
                      {enrollment.paused ? "Resume" : "Pause"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </SettingsSection>

            <SettingsSection title="Independent status" card>
              <StatusRow label="Metro connection" value={indicators.metro} />
              <StatusRow label="Device broker" value={indicators.device} />
              <StatusRow label="Permissions" value={indicators.permissions} />
              <StatusRow
                label="Screen capture"
                value={permissionLabel(enrollment.permissions.screenCapture)}
              />
              <StatusRow
                label="Accessibility"
                value={permissionLabel(enrollment.permissions.accessibility)}
              />
              <StatusRow label="VPN" value={permissionLabel(enrollment.permissions.vpn)} />
              <StatusRow
                label="Wireless debugging"
                value={permissionLabel(enrollment.permissions.wirelessDebugging)}
              />
              <StatusRow label="Agent input lease" value={indicators.lease} />
            </SettingsSection>

            <SettingsSection title="Safety" card>
              <View className="gap-3 p-4">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-12 items-center justify-center rounded-[16px] bg-danger px-4 disabled:opacity-40"
                  disabled={control.status === "inactive"}
                  onPress={() => setControl(stopAndroidDeviceControl())}
                >
                  <Text className="font-t3-bold text-white">Stop device control</Text>
                </Pressable>
                <Text className="text-sm leading-normal text-foreground-muted">
                  This control becomes active whenever screen capture or agent input holds a lease.
                  Pausing or revoking does not stop the Daytona run.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  className="min-h-12 justify-center"
                  onPress={revoke}
                >
                  <Text className="text-center font-t3-bold text-danger">Revoke device host</Text>
                </Pressable>
              </View>
            </SettingsSection>
          </>
        )}

        <View className="gap-2 px-2">
          <Text className="text-sm leading-normal text-foreground-muted">
            Android may stop a future broker unless its foreground-service notification is visible,
            and battery restrictions can still disconnect it. T3 reconnects only to the enrolled
            controller and lease.
          </Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            A signed development build, Google Play policy review, and the CA-67 device broker are
            required before device control can become available. The development build and T3 Code
            remain separate apps when opening a Metro link.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
