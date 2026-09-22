import { useAtomValue } from "@effect/atom-react";
import {
  buildCloudAgentFollowUpCommand,
  cloudAgentStatusLabel,
  cloudInspectionText,
  cloudReviewActionLabel,
} from "@t3tools/client-runtime/cloud-agents";
import { cloudWorkerConnectionRegistration } from "@t3tools/client-runtime/connection";
import {
  CommandId,
  type CloudAgentId,
  type CloudAgentReview,
  type CloudAgentReviewAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { environmentCatalog } from "../../connection/catalog";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cloudAllocations } from "../../state/cloud-allocations";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useDeviceHostEnrollment } from "../device-host/useDeviceHostEnrollment";

interface CloudAgentReviewRouteProps {
  readonly route: {
    readonly params: {
      readonly environmentId: EnvironmentId;
      readonly agentId: CloudAgentId;
    };
  };
}

function LinkButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={
        props.destructive
          ? "min-h-11 items-center justify-center rounded-[14px] bg-danger px-4 disabled:opacity-40"
          : "min-h-11 items-center justify-center rounded-[14px] bg-subtle px-4 disabled:opacity-40"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={props.destructive ? "font-t3-bold text-white" : "font-t3-bold text-foreground"}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function CloudAgentReviewRouteScreen(props: CloudAgentReviewRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, agentId } = props.route.params;
  const inspect = useAtomCommand(cloudAllocations.inspectAgentReview, { reportFailure: false });
  const act = useAtomCommand(cloudAllocations.actAgentReview, { reportFailure: false });
  const dispatch = useAtomCommand(cloudAllocations.dispatch, { reportFailure: false });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const snapshotResult = useAtomValue(cloudAllocations.snapshot({ environmentId, input: {} }));
  const snapshot = AsyncResult.isSuccess(snapshotResult) ? snapshotResult.value : null;
  const [review, setReview] = useState<CloudAgentReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const { enrollment } = useDeviceHostEnrollment();
  const allocation = snapshot?.allocations.find(
    (candidate) => candidate.id === review?.allocationId,
  );

  const load = useCallback(async () => {
    const result = await inspect({ environmentId, input: { agentId } });
    if (AsyncResult.isSuccess(result)) {
      setReview(result.value);
      setError(null);
      return;
    }
    setError("This cloud agent is not available for review.");
  }, [agentId, environmentId, inspect]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: CloudAgentReviewAction) => {
    setBusy(true);
    const result = await act({
      environmentId,
      input: {
        agentId,
        action,
        commandId: CommandId.make(`mobile-cloud-action:${Crypto.randomUUID()}`),
        occurredAt: new Date().toISOString(),
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setReview(result.value);
      setError(null);
      return;
    }
    setError("The controller rejected that action.");
  };

  const confirmAction = (action: CloudAgentReviewAction) => {
    if (action !== "delete" && action !== "delete-pr") {
      void runAction(action);
      return;
    }
    Alert.alert(
      action === "delete" ? "Delete cloud agent?" : "Delete pull request?",
      "This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void runAction(action) },
      ],
    );
  };

  const sendFollowUp = async () => {
    if (allocation === undefined || snapshot === null) return;
    const built = buildCloudAgentFollowUpCommand({
      allocation,
      prompt: followUp,
      limits: snapshot.limits,
      now: new Date(),
      requestId: Crypto.randomUUID(),
    });
    if (built.status === "invalid") {
      setError(built.message);
      return;
    }
    setBusy(true);
    const result = await dispatch({ environmentId, input: built.command });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      setError("The controller rejected the follow-up.");
      return;
    }
    setFollowUp("");
    setError(null);
    await load();
  };

  const openLiveThread = async () => {
    if (allocation === undefined) return;
    const registration = cloudWorkerConnectionRegistration(allocation);
    if (registration === null || allocation.allocationState.status !== "ready") return;
    const result = await registerEnvironment(registration);
    if (AsyncResult.isFailure(result)) {
      setError("The worker connection could not be saved.");
      return;
    }
    navigation.navigate("Thread", {
      environmentId: allocation.allocationState.references.environmentId,
      threadId: allocation.allocationState.references.threadId,
    });
  };

  const pullRequestUrl =
    review?.publication.status === "present" && review.publication.outcome.status === "published"
      ? review.publication.outcome.pullRequestUrl
      : null;
  const previewUrl = review?.previewState.status === "available" ? review.previewState.url : null;
  const deviceHostMatches =
    enrollment.status === "enrolled" && enrollment.environmentId === environmentId;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Cloud agent" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {review === null ? (
          <Text className="text-base text-foreground-muted">
            {error ?? "Loading retained review…"}
          </Text>
        ) : (
          <>
            <View className="gap-3 rounded-[24px] bg-card px-5 py-5">
              <View className="flex-row items-start justify-between gap-3">
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-xl font-t3-bold text-foreground">
                    {review.agent.conversation.title}
                  </Text>
                  <Text className="text-sm text-foreground-muted">{review.agent.repository}</Text>
                </View>
                <StatusPill
                  label={cloudAgentStatusLabel(review.agentStatus)}
                  pillClassName={review.agentStatus === "ACTIVE" ? "bg-success/15" : "bg-subtle"}
                  textClassName={
                    review.agentStatus === "ACTIVE" ? "text-success" : "text-foreground-muted"
                  }
                />
              </View>
              <Text className="text-sm leading-normal text-foreground-muted">
                Run {review.latestRun.status}. Reviewing retained results does not wake compute.
              </Text>
              {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            </View>

            <SettingsSection title="Live controls" card>
              <View className="gap-3 p-4">
                <View className="gap-2">
                  <Text className="text-sm text-foreground-muted">
                    Daytona preview: {previewUrl ? "Available" : "Unavailable"}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    Metro link:{" "}
                    {allocation?.profile.device === "android"
                      ? "Not published"
                      : "Not an Android run"}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    Device control:{" "}
                    {deviceHostMatches
                      ? "Enrolled, broker unavailable"
                      : "Not enrolled for this controller"}
                  </Text>
                </View>
                {previewUrl ? (
                  <LinkButton
                    label="Open Daytona preview"
                    onPress={() => void Linking.openURL(previewUrl)}
                  />
                ) : null}
                {allocation?.allocationState.status === "ready" ? (
                  <LinkButton label="Open live thread" onPress={() => void openLiveThread()} />
                ) : null}
              </View>
            </SettingsSection>

            {review.agentStatus === "IDLE" ? (
              <SettingsSection title="Follow up" card>
                <View className="gap-3 p-4">
                  <TextInput
                    accessibilityLabel="Cloud agent follow-up"
                    className="min-h-24 rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
                    multiline
                    onChangeText={setFollowUp}
                    placeholder="Ask the agent to continue"
                    placeholderTextColorClassName="text-foreground-muted"
                    textAlignVertical="top"
                    value={followUp}
                  />
                  <LinkButton
                    label="Send follow-up"
                    disabled={busy}
                    onPress={() => void sendFollowUp()}
                  />
                </View>
              </SettingsSection>
            ) : null}

            <SettingsSection title="Pull request and artifacts" card>
              <View className="gap-3 p-4">
                {pullRequestUrl ? (
                  <LinkButton
                    label="Review pull request"
                    onPress={() => void Linking.openURL(pullRequestUrl)}
                  />
                ) : (
                  <Text className="text-sm text-foreground-muted">No pull request published.</Text>
                )}
                {review.artifacts.length === 0 ? (
                  <Text className="text-sm text-foreground-muted">No retained artifacts.</Text>
                ) : (
                  review.artifacts.map((artifact) =>
                    artifact.status === "available" ? (
                      <LinkButton
                        key={artifact.entry.fileId}
                        label={
                          artifact.htmlUntrusted
                            ? `${artifact.entry.name} (download)`
                            : artifact.entry.name
                        }
                        onPress={() => void Linking.openURL(artifact.entry.url)}
                      />
                    ) : (
                      <Text
                        key={`${artifact.name}:${artifact.reason}`}
                        className="text-sm text-foreground-muted"
                      >
                        {artifact.name}: {artifact.reason}
                      </Text>
                    ),
                  )
                )}
              </View>
            </SettingsSection>

            <SettingsSection title="Retained output" card>
              <View className="gap-4 p-4">
                <Text className="text-sm font-t3-bold text-foreground">Changes</Text>
                <Text selectable className="font-mono text-xs leading-normal text-foreground-muted">
                  {cloudInspectionText(review.diff)}
                </Text>
                <Text className="text-sm font-t3-bold text-foreground">Verification</Text>
                <Text selectable className="font-mono text-xs leading-normal text-foreground-muted">
                  {cloudInspectionText(review.verification)}
                </Text>
              </View>
            </SettingsSection>

            <SettingsSection title="Agent actions" card>
              <View className="gap-3 p-4">
                {review.actions.map((entry) => (
                  <LinkButton
                    key={entry.action}
                    label={cloudReviewActionLabel(entry.action)}
                    disabled={busy || !entry.available}
                    destructive={entry.action === "delete" || entry.action === "delete-pr"}
                    onPress={() => confirmAction(entry.action)}
                  />
                ))}
              </View>
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </View>
  );
}
