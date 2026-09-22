import { useAtomValue } from "@effect/atom-react";
import {
  buildCloudAgentLaunchCommand,
  cloudAgentStatusLabel,
} from "@t3tools/client-runtime/cloud-agents";
import { isCloudProviderEnabled, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { useNavigation } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cloudAllocations } from "../../state/cloud-allocations";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function providerSelection(config: ServerConfig) {
  const provider = config.providers.find(
    (candidate) =>
      isCloudProviderEnabled(candidate.driver) &&
      candidate.enabled &&
      candidate.installed &&
      candidate.status === "ready" &&
      candidate.auth.status !== "unauthenticated" &&
      candidate.models.length > 0,
  );
  const model =
    provider?.models.find((candidate) => candidate.isDefault)?.slug ?? provider?.models[0]?.slug;
  return provider && model ? { instanceId: provider.instanceId, model } : null;
}

export function CloudAgentsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const serverConfigs = useServerConfigs();
  const capableEnvironments = useMemo(
    () =>
      [...serverConfigs.entries()].filter(
        ([, config]) => config.environment.capabilities.cloudAllocations === true,
      ),
    [serverConfigs],
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const resolvedEnvironmentId = capableEnvironments.some(
    ([candidate]) => candidate === environmentId,
  )
    ? environmentId
    : (capableEnvironments[0]?.[0] ?? null);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Cloud agents" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {capableEnvironments.length > 1 ? (
          <SettingsSection title="Controller" card>
            {capableEnvironments.map(([candidate, config]) => {
              const selected = candidate === resolvedEnvironmentId;
              return (
                <Pressable
                  key={candidate}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className="min-h-12 justify-center border-b border-border px-4 last:border-b-0"
                  onPress={() => setEnvironmentId(candidate)}
                >
                  <Text className={selected ? "font-t3-bold text-primary" : "text-foreground"}>
                    {config.environment.label ?? candidate}
                  </Text>
                </Pressable>
              );
            })}
          </SettingsSection>
        ) : null}

        {resolvedEnvironmentId === null ? (
          <View className="rounded-[24px] bg-card px-5 py-6">
            <Text className="text-base text-foreground-muted">
              Connect a controller with Cloud Agents enabled to create or review agents.
            </Text>
          </View>
        ) : (
          <CloudAgentsForEnvironment
            key={resolvedEnvironmentId}
            environmentId={resolvedEnvironmentId}
          />
        )}
      </ScrollView>
    </View>
  );
}

function CloudAgentsForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const config = serverConfigs.get(props.environmentId);
  const snapshotResult = useAtomValue(
    cloudAllocations.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = AsyncResult.isSuccess(snapshotResult) ? snapshotResult.value : null;
  const dispatch = useAtomCommand(cloudAllocations.dispatch, { reportFailure: false });
  const repositories = useMemo(
    () =>
      projects.flatMap((project) => {
        if (project.environmentId !== props.environmentId || project.repositoryIdentity === null) {
          return [];
        }
        const repository = sourceControlRepositorySelector(project.repositoryIdentity);
        return repository === null ? [] : [{ title: project.title, repository }];
      }),
    [projects, props.environmentId],
  );
  const [repository, setRepository] = useState(() => repositories[0]?.repository ?? "");
  const [selectedRef, setSelectedRef] = useState("main");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    if (snapshot === null || config === undefined) return;
    const provider = providerSelection(config);
    const built = buildCloudAgentLaunchCommand({
      repository: repository || repositories[0]?.repository || "",
      selectedRef,
      task,
      providerInstanceId: provider?.instanceId ?? "",
      model: provider?.model ?? "",
      limits: snapshot.limits,
      now: new Date(),
      requestId: Crypto.randomUUID(),
    });
    if (built.status === "invalid") {
      setError(built.message);
      return;
    }
    setBusy(true);
    const result = await dispatch({ environmentId: props.environmentId, input: built.command });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      setError("The controller rejected the cloud run.");
      return;
    }
    setTask("");
    setError(null);
  };

  return (
    <>
      <SettingsSection title="New cloud agent" card>
        <View className="gap-3 p-4">
          {repositories.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2"
            >
              {repositories.map((option) => {
                const selected = repository === option.repository;
                return (
                  <Pressable
                    key={option.repository}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    className={
                      selected
                        ? "min-h-10 justify-center rounded-full bg-primary px-4"
                        : "min-h-10 justify-center rounded-full bg-subtle px-4"
                    }
                    onPress={() => setRepository(option.repository)}
                  >
                    <Text
                      className={
                        selected
                          ? "font-t3-medium text-primary-foreground"
                          : "font-t3-medium text-foreground"
                      }
                    >
                      {option.title}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
          <TextInput
            accessibilityLabel="Cloud repository"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
            onChangeText={setRepository}
            placeholder="owner/repository"
            placeholderTextColorClassName="text-foreground-muted"
            value={repository || repositories[0]?.repository || ""}
          />
          <TextInput
            accessibilityLabel="Starting branch"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
            onChangeText={setSelectedRef}
            placeholder="main"
            placeholderTextColorClassName="text-foreground-muted"
            value={selectedRef}
          />
          <TextInput
            accessibilityLabel="Cloud task"
            className="min-h-28 rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
            multiline
            onChangeText={setTask}
            placeholder="Describe the task"
            placeholderTextColorClassName="text-foreground-muted"
            textAlignVertical="top"
            value={task}
          />
          <Text className="text-sm leading-normal text-foreground-muted">
            Starts a full-access cloud run and opens a draft pull request. Closing or backgrounding
            T3 Code does not stop the run while the controller remains online.
          </Text>
          {error ? <Text className="text-sm text-danger">{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-[16px] bg-primary px-4 disabled:opacity-40"
            disabled={busy || snapshot === null}
            onPress={() => void launch()}
          >
            <Text className="font-t3-bold text-primary-foreground">
              {busy ? "Starting…" : "Start cloud agent"}
            </Text>
          </Pressable>
        </View>
      </SettingsSection>

      <SettingsSection title="Agents" card>
        {snapshot === null ? (
          <Text className="p-4 text-sm text-foreground-muted">Loading cloud agents…</Text>
        ) : (snapshot.agents ?? []).length === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">No cloud agents yet.</Text>
        ) : (
          (snapshot.agents ?? []).map((agent) => (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              className="flex-row items-center gap-3 border-b border-border px-4 py-4 last:border-b-0"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsCloudAgentReview",
                    params: { environmentId: props.environmentId, agentId: agent.id },
                  },
                })
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                  {agent.conversation.title}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {agent.repository}
                </Text>
              </View>
              <StatusPill
                size="compact"
                label={cloudAgentStatusLabel(agent.status)}
                pillClassName={agent.status === "ACTIVE" ? "bg-success/15" : "bg-subtle"}
                textClassName={agent.status === "ACTIVE" ? "text-success" : "text-foreground-muted"}
              />
            </Pressable>
          ))
        )}
      </SettingsSection>
    </>
  );
}
