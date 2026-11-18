import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";

import type { CloudCliRunner } from "../../provider/CloudCli.ts";
import {
  CloudCliError,
  parseClaudeCloudCreateOutput,
  parseClaudeCloudFollowUpResponse,
} from "../../provider/CloudCli.ts";
import {
  cloudNativeModel,
  type CodexCloudProtocol,
  type CodexCloudEvent,
} from "../../provider/CodexCloudProtocol.ts";
import type { CodexCloudWarmThread } from "../../provider/CodexCloudWarmThread.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { codexDefaultReasoningEffortOverride } from "../../provider/CodexProvider.ts";
import type { ClaudeCloudEvent, ClaudeCloudSessions } from "../../provider/ClaudeCloudSessions.ts";

const CODEX_CLOUD_MAX_POLL_FAILURES = 5;
const CODEX_CLOUD_MAX_WAIT_MS = 60 * 60 * 1_000;
const CLAUDE_TOOL_OUTPUT_MAX_CHARS = 8_000;
const SESSION_ID_PATTERN = /session_[0-9A-Za-z]+/u;

export type CloudAdapterFlavor = "claude" | "codex";

export interface CloudAdapterConfig {
  readonly binaryPath: string;
  /** Codex Cloud environment id set in settings; otherwise the project's repository picks one. */
  readonly environment?: string | undefined;
}

export interface CloudAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly flavor: CloudAdapterFlavor;
  readonly config: CloudAdapterConfig;
  readonly runner: CloudCliRunner;
  readonly environment?: NodeJS.ProcessEnv;
  /** How often to poll Codex Cloud for task completion. */
  readonly pollInterval?: Duration.Input | undefined;
  /** Finds the Codex Cloud environment for the project's GitHub repository. */
  readonly resolveEnvironment?:
    | ((cwd: string) => Effect.Effect<string, { readonly message: string }>)
    | undefined;
  readonly nativeProtocol?:
    | ((cwd: string) => Effect.Effect<CodexCloudProtocol, { readonly message: string }>)
    | undefined;
  /** Reads Claude Cloud transcripts back into the thread; without it turns only submit. */
  readonly claudeSessions?: ClaudeCloudSessions | undefined;
  /** A Codex Cloud thread created ahead of the first message, when the user picked the host. */
  readonly warmThread?: CodexCloudWarmThread | undefined;
}

const CLOUD_PROVIDER_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
};

const sessionRef = (driver: ProviderDriverKind, nativeId: string | null) => ({
  driver,
  nativeId,
  strength: nativeId === null ? ("none" as const) : ("strong" as const),
});

const weakRef = (driver: ProviderDriverKind, nativeId: string) => ({
  driver,
  nativeId,
  strength: "weak" as const,
});

const sessionIdFromNativeRef = (
  ref: { readonly nativeId: string | null } | null,
): string | null => {
  const nativeId = ref?.nativeId;
  if (nativeId === null || nativeId === undefined) return null;
  return SESSION_ID_PATTERN.test(nativeId) ? nativeId : null;
};

interface ActiveCloudTurn {
  providerTurn: OrchestrationV2ProviderTurn;
  readonly runId: RunId;
  readonly runOrdinal: number;
  readonly rootNodeId: NodeId;
  readonly prompt: string;
  readonly branch: string | null;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly ultracode: boolean | undefined;
  readonly serviceTier: string | undefined;
  nativeTurnId: string | null;
  nativeProtocol: CodexCloudProtocol | null;
  /** Set once the forked turn fiber is known; null until then means nothing to interrupt. */
  fiber: Fiber.Fiber<void, unknown> | null;
  interrupted: boolean;
  itemOrdinal: number;
}

interface CloudThreadState {
  readonly threadId: ThreadId;
  providerThread: OrchestrationV2ProviderThread;
  /** Claude cloud session id, once the first turn created one. */
  sessionId: string | null;
  /** Codex cloud environment the thread's tasks ran in, once submitted. */
  codexEnvironment: string | null;
  /** Settings the Claude cloud session runs with; null when unknown after a restart. */
  claudeModel: string | null;
  claudeEffort: string | null;
  claudeUltracode: boolean | null;
  turns: OrchestrationV2ProviderTurn[];
  messages: OrchestrationV2ConversationMessage[];
  items: OrchestrationV2TurnItem[];
  activeTurn: ActiveCloudTurn | null;
}

export const createCloudAdapterV2 = Effect.fn("CloudAdapterV2.create")(function* (
  options: CloudAdapterV2Options,
) {
  const { driver, instanceId, flavor, config, runner } = options;
  // Each read is one small request; at five seconds it added seconds of lag to every reply.
  const transcriptPollInterval = options.pollInterval ?? "1 second";
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const spawnEnvironment = options.environment;
  const followsClaudeTranscript = flavor === "claude" && options.claudeSessions !== undefined;
  const capabilities: OrchestrationV2ProviderCapabilities = {
    ...CLOUD_PROVIDER_CAPABILITIES,
    sessions: {
      ...CLOUD_PROVIDER_CAPABILITIES.sessions,
      supportsModelSwitchInSession: followsClaudeTranscript,
    },
    turns: {
      ...CLOUD_PROVIDER_CAPABILITIES.turns,
      terminalStatusQuality: flavor === "claude" && !followsClaudeTranscript ? "none" : "strong",
      exposesNativeTurnId: options.nativeProtocol !== undefined,
    },
    streaming: {
      ...CLOUD_PROVIDER_CAPABILITIES.streaming,
      streamsAssistantText: options.nativeProtocol !== undefined || followsClaudeTranscript,
    },
    tools: {
      ...CLOUD_PROVIDER_CAPABILITIES.tools,
      exposesToolItemIds: followsClaudeTranscript,
      emitsToolStarted: followsClaudeTranscript,
      emitsToolCompleted: followsClaudeTranscript,
      emitsToolOutput: followsClaudeTranscript,
    },
    checkpointing: {
      ...CLOUD_PROVIDER_CAPABILITIES.checkpointing,
      appCanCheckpointFilesystem: options.nativeProtocol === undefined,
    },
    identity: {
      ...CLOUD_PROVIDER_CAPABILITIES.identity,
      nativeTurnIds: options.nativeProtocol ? "strong" : "weak",
    },
  };

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("ProviderAdapterV2.getCapabilities")(() =>
      Effect.succeed(capabilities),
    ),
    planSelectionTransition: Effect.fn("ProviderAdapterV2.planSelectionTransition")((selection) =>
      Effect.succeed(
        options.nativeProtocol && selection.current.model !== selection.target.model
          ? {
              type: "reject" as const,
              reason:
                "Start a new cloud chat to choose another model. This conversation keeps its saved cloud model.",
            }
          : turnScopedSelectionTransition(),
      ),
    ),
    openSession: Effect.fn("CloudAdapterV2.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<
        ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const emit = (event: ProviderAdapterV2Event) => Queue.offer(events, event);
      const threads = new Map<ThreadId, CloudThreadState>();
      const cwd = input.runtimePolicy.cwd ?? process.cwd();
      const providerSessionRef = yield* Ref.make<OrchestrationV2ProviderSession>({
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model ?? null,
        capabilities,
        createdAt: yield* DateTime.now,
        updatedAt: yield* DateTime.now,
        lastError: null,
      });

      const updateSession = Effect.fn("CloudAdapterV2.updateSession")(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null,
      ) {
        const session = yield* Ref.get(providerSessionRef);
        const next = {
          ...session,
          status,
          lastError,
          updatedAt: yield* DateTime.now,
        };
        yield* Ref.set(providerSessionRef, next);
        yield* emit({ type: "provider_session.updated", driver, providerSession: next });
      });

      const setStateThread = Effect.fn("CloudAdapterV2.setStateThread")(function* (
        state: CloudThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        state.providerThread = {
          ...state.providerThread,
          ...patch,
          updatedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver,
          providerThread: state.providerThread,
        });
      });

      const ensureThreadState = Effect.fn("CloudAdapterV2.ensureThreadState")(
        function* (adoptInput: {
          readonly threadId: ThreadId;
          readonly existingProviderThread?: OrchestrationV2ProviderThread | undefined;
        }) {
          const existing = threads.get(adoptInput.threadId);
          if (existing !== undefined) return existing;
          const createdAt = yield* DateTime.now;
          let providerThread: OrchestrationV2ProviderThread;
          if (adoptInput.existingProviderThread !== undefined) {
            providerThread = {
              ...adoptInput.existingProviderThread,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: createdAt,
            };
          } else {
            providerThread = {
              id: idAllocator.derive.providerThread({
                driver,
                providerInstanceId: instanceId,
                nativeThreadId: adoptInput.threadId,
              }),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: adoptInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: sessionRef(
                driver,
                // Codex tasks address the configured environment directly; Claude
                // names its session only after the first turn created one.
                flavor === "codex" && !options.nativeProtocol
                  ? config.environment || "default"
                  : null,
              ),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
          }
          const nativeId = providerThread.nativeThreadRef?.nativeId ?? null;
          const legacyEnvironmentRef =
            options.nativeProtocol &&
            nativeId !== null &&
            (nativeId === "default" || nativeId === config.environment);
          if (legacyEnvironmentRef)
            providerThread = { ...providerThread, nativeThreadRef: sessionRef(driver, null) };
          const state: CloudThreadState = {
            threadId: adoptInput.threadId,
            providerThread,
            sessionId: options.nativeProtocol
              ? (providerThread.nativeThreadRef?.nativeId ?? null)
              : flavor === "claude"
                ? sessionIdFromNativeRef(providerThread.nativeThreadRef)
                : null,
            codexEnvironment: flavor === "codex" ? config.environment || null : null,
            claudeModel: null,
            claudeEffort: null,
            claudeUltracode: null,
            turns: [],
            messages: [],
            items: [],
            activeTurn: null,
          };
          threads.set(adoptInput.threadId, state);
          yield* emit({ type: "provider_thread.updated", driver, providerThread });
          return state;
        },
      );

      const emitNotificationItem = Effect.fn("CloudAdapterV2.emitNotificationItem")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        summary: string,
        detail?: string,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:note:${turn.itemOrdinal}`;
        turn.itemOrdinal += 1;
        const at = yield* DateTime.now;
        const item: OrchestrationV2TurnItem = {
          type: "notification",
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
          threadId: state.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: turn.itemOrdinal,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          source: { kind: "system" },
          outcome: "completed",
          summary,
          ...(detail === undefined ? {} : { detail }),
        };
        state.items.push(item);
        yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      });

      const emitAssistantMessage = Effect.fn("CloudAdapterV2.emitAssistantMessage")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        text: string,
        streamingItem?: { readonly id: string; readonly streaming: boolean },
      ) {
        const at = yield* DateTime.now;
        const nativeItemId =
          streamingItem?.id ?? `${turn.providerTurn.id}:result:${turn.itemOrdinal}`;
        const messageId = idAllocator.derive.messageFromProviderItem({ driver, nativeItemId });
        const previousMessage = state.messages.find((message) => message.id === messageId);
        const previousItem = state.items.find(
          (item) => item.type === "assistant_message" && item.messageId === messageId,
        );
        if (!previousMessage) turn.itemOrdinal += 1;
        const message: OrchestrationV2ConversationMessage = {
          createdBy: "agent",
          creationSource: "provider",
          id: messageId,
          threadId: state.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming: streamingItem?.streaming ?? false,
          createdAt: previousMessage?.createdAt ?? at,
          updatedAt: at,
        };
        const item: OrchestrationV2TurnItem = {
          type: "assistant_message",
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
          threadId: state.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: weakRef(driver, nativeItemId),
          parentItemId: null,
          ordinal: previousItem?.ordinal ?? turn.itemOrdinal,
          status: streamingItem?.streaming ? "running" : "completed",
          title: null,
          startedAt: previousItem?.startedAt ?? at,
          completedAt: streamingItem?.streaming ? null : at,
          updatedAt: at,
          messageId,
          text,
          attachments: [],
          streaming: streamingItem?.streaming ?? false,
        };
        if (previousMessage) state.messages[state.messages.indexOf(previousMessage)] = message;
        else state.messages.push(message);
        if (previousItem) state.items[state.items.indexOf(previousItem)] = item;
        else state.items.push(item);
        yield* emit({ type: "message.updated", driver, message });
        yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      });

      const finishTurn = Effect.fn("CloudAdapterV2.finishTurn")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        status: "completed" | "interrupted" | "cancelled" | "failed",
        detail?: string,
        disposition: "reusable" | "broken" = "reusable",
      ) {
        if (state.activeTurn !== turn) return;
        for (const message of state.messages.filter(
          (message) => message.runId === turn.runId && message.streaming,
        )) {
          const item = state.items.find(
            (item) => item.type === "assistant_message" && item.messageId === message.id,
          );
          if (item?.nativeItemRef?.nativeId)
            yield* emitAssistantMessage(state, turn, message.text, {
              id: item.nativeItemRef.nativeId,
              streaming: false,
            });
        }
        for (let index = 0; index < state.items.length; index += 1) {
          const item = state.items[index]!;
          if (item.runId !== turn.runId || item.type !== "file_change" || item.status !== "running")
            continue;
          const at = yield* DateTime.now;
          const completed = { ...item, status, completedAt: at, updatedAt: at };
          state.items[index] = completed;
          yield* emit({ type: "turn_item.updated", driver, turnItem: completed });
        }
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          ...turn.providerTurn,
          status,
          completedAt,
        };
        state.turns.push(providerTurn);
        yield* emit({ type: "provider_turn.updated", driver, providerTurn });
        yield* setStateThread(state, {
          status: disposition === "broken" ? "error" : "idle",
          nativeConversationHeadRef: state.providerThread.nativeThreadRef,
        });
        yield* updateSession(
          disposition === "broken" ? "error" : "ready",
          status === "failed" ? (detail ?? null) : null,
        );
        if (status === "failed") {
          const failure: OrchestrationV2ProviderFailure = makeProviderFailure({
            class: disposition === "broken" ? "transport_error" : "provider_error",
            message: detail ?? "The cloud task failed.",
          });
          const failureItem = makeProviderFailureTurnItem({
            driver,
            threadId: state.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: turn.itemOrdinal,
            failure,
            occurredAt: completedAt,
          });
          turn.itemOrdinal += 1;
          state.items.push(failureItem);
          yield* emit({ type: "turn_item.updated", driver, turnItem: failureItem });
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnId: providerTurn.id,
            runOrdinal: turn.runOrdinal,
            status: "failed",
            failure,
            failureItemOrdinal: failureItem.ordinal,
            threadDisposition: disposition,
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnId: providerTurn.id,
            runOrdinal: turn.runOrdinal,
            status,
            failure: null,
            threadDisposition: disposition,
          });
        }
        yield* emit({
          type: "background_work.updated",
          driver,
          providerTurnId: turn.providerTurn.id,
          pending: false,
        });
      });

      const emitCloudFiles = Effect.fn("CloudAdapterV2.emitCloudFiles")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        event: Extract<CodexCloudEvent, { type: "files" }>,
      ) {
        for (const change of event.changes) {
          const at = yield* DateTime.now;
          const nativeItemId = `${event.itemId}:${change.path}`;
          const id = idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId });
          const previous = state.items.find((item) => item.id === id);
          if (!previous) turn.itemOrdinal += 1;
          const item: OrchestrationV2TurnItem = {
            type: "file_change",
            id,
            threadId: state.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: weakRef(driver, nativeItemId),
            parentItemId: null,
            ordinal: previous?.ordinal ?? turn.itemOrdinal,
            status: event.complete ? "completed" : "running",
            title: "Cloud file change",
            startedAt: previous?.startedAt ?? at,
            completedAt: event.complete ? at : null,
            updatedAt: at,
            fileName: change.movePath || change.path,
            diffStr: change.diff,
            ...(change.operation === "unknown"
              ? {}
              : {
                  changes: [
                    {
                      operation: change.operation,
                      path: change.movePath || change.path,
                      ...(change.movePath ? { oldPath: change.path } : {}),
                    },
                  ],
                }),
          };
          if (previous) state.items[state.items.indexOf(previous)] = item;
          else state.items.push(item);
          yield* emit({ type: "turn_item.updated", driver, turnItem: item });
        }
      });

      /** The turn must still own the thread at every resume point after an await. */
      const turnLive = (state: CloudThreadState, turn: ActiveCloudTurn) =>
        state.activeTurn === turn && !turn.interrupted;

      const emitClaudeTool = Effect.fn("CloudAdapterV2.emitClaudeTool")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        tool: Extract<ClaudeCloudEvent, { type: "tool" }>,
        result?: Extract<ClaudeCloudEvent, { type: "tool_result" }>,
      ) {
        const at = yield* DateTime.now;
        const id = idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: tool.id });
        const index = state.items.findIndex((item) => item.id === id);
        const previous = index === -1 ? undefined : state.items[index];
        if (previous === undefined) turn.itemOrdinal += 1;
        const name = tool.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/u, "");
        const text = (key: string) => {
          const value = tool.input[key];
          return typeof value === "string" && value.trim() ? value : undefined;
        };
        const output = result?.output.slice(0, CLAUDE_TOOL_OUTPUT_MAX_CHARS);
        const base = {
          id,
          threadId: state.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: weakRef(driver, tool.id),
          parentItemId: null,
          ordinal: previous?.ordinal ?? turn.itemOrdinal,
          status: result === undefined ? "running" : result.isError ? "failed" : "completed",
          startedAt: previous?.startedAt ?? at,
          completedAt: result === undefined ? null : at,
          updatedAt: at,
        } as const;
        const filePath = text("file_path") ?? text("notebook_path");
        const item: OrchestrationV2TurnItem =
          name === "Bash"
            ? {
                ...base,
                type: "command_execution",
                title: text("description") ?? null,
                input: text("command") ?? "",
                ...(output ? { output, outputIndicatesFailure: result?.isError === true } : {}),
              }
            : (name === "Edit" ||
                  name === "Write" ||
                  name === "MultiEdit" ||
                  name === "NotebookEdit") &&
                filePath !== undefined
              ? {
                  ...base,
                  type: "file_change",
                  title: null,
                  fileName: filePath,
                  ...(text("old_string") === undefined ? {} : { oldStr: text("old_string") }),
                  ...((text("new_string") ?? text("content")) === undefined
                    ? {}
                    : { newStr: text("new_string") ?? text("content") }),
                }
              : name === "WebSearch" || name === "WebFetch"
                ? {
                    ...base,
                    type: "web_search",
                    title: null,
                    patterns: [text("query") ?? text("url") ?? name],
                  }
                : {
                    ...base,
                    type: "dynamic_tool",
                    title: filePath ?? text("pattern") ?? text("description") ?? null,
                    toolName: name || "tool",
                    input: tool.input,
                    ...(output ? { output } : {}),
                  };
        if (previous === undefined) state.items.push(item);
        else state.items[index] = item;
        yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      });

      const emitClaudeReasoning = Effect.fn("CloudAdapterV2.emitClaudeReasoning")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        event: Extract<ClaudeCloudEvent, { type: "reasoning" }>,
      ) {
        const at = yield* DateTime.now;
        turn.itemOrdinal += 1;
        const item: OrchestrationV2TurnItem = {
          type: "reasoning",
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: event.id }),
          threadId: state.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: weakRef(driver, event.id),
          parentItemId: null,
          ordinal: turn.itemOrdinal,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          text: event.text,
          streaming: false,
        };
        state.items.push(item);
        yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      });

      const finishWithoutTranscript = Effect.fn("CloudAdapterV2.finishWithoutTranscript")(
        function* (state: CloudThreadState, turn: ActiveCloudTurn) {
          yield* emitAssistantMessage(
            state,
            turn,
            `Submitted to Claude Cloud. [Open the cloud session](https://claude.ai/code/${state.sessionId}) to see replies, progress, and file changes.`,
          );
          if (!turnLive(state, turn)) return;
          yield* finishTurn(state, turn, "completed");
        },
      );

      /** Mirrors the session transcript into the turn until the remote turn's result arrives. */
      const followClaudeTranscript = Effect.fn("CloudAdapterV2.followClaudeTranscript")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
        sessions: ClaudeCloudSessions,
        sessionId: string,
        startCursor: string | null,
      ) {
        const tools = new Map<string, Extract<ClaudeCloudEvent, { type: "tool" }>>();
        const deadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + CODEX_CLOUD_MAX_WAIT_MS;
        let cursor = startCursor;
        let sawPrompt = false;
        let failures = 0;
        while (DateTime.toEpochMillis(DateTime.nowUnsafe()) < deadline) {
          if (!turnLive(state, turn)) return;
          const page = yield* sessions.readEvents(sessionId, cursor).pipe(Effect.result);
          if (!turnLive(state, turn)) return;
          if (Result.isFailure(page)) {
            if (page.failure.signedOut) return yield* finishWithoutTranscript(state, turn);
            failures += 1;
            if (page.failure.status === 401 || failures > CODEX_CLOUD_MAX_POLL_FAILURES)
              return yield* finishTurn(
                state,
                turn,
                "failed",
                `Lost the Claude Cloud transcript: ${page.failure.detail} The session keeps running at https://claude.ai/code/${sessionId}.`,
              );
            yield* Effect.sleep(transcriptPollInterval);
            continue;
          }
          failures = 0;
          cursor = page.success.cursor;
          for (const event of page.success.events) {
            if (!turnLive(state, turn)) return;
            if (event.type === "client_message") {
              sawPrompt = true;
              continue;
            }
            // Anything before this turn's prompt belongs to an earlier turn.
            if (!sawPrompt) continue;
            if (event.type === "text") {
              yield* emitAssistantMessage(state, turn, event.text, {
                id: event.id,
                streaming: false,
              });
            } else if (event.type === "reasoning") {
              yield* emitClaudeReasoning(state, turn, event);
            } else if (event.type === "tool") {
              tools.set(event.id, event);
              yield* emitClaudeTool(state, turn, event);
            } else if (event.type === "tool_result") {
              const tool = tools.get(event.id);
              if (tool !== undefined) yield* emitClaudeTool(state, turn, tool, event);
            } else {
              return yield* finishTurn(
                state,
                turn,
                event.ok ? "completed" : "failed",
                event.text ?? "Claude Cloud reported an error.",
              );
            }
          }
          yield* Effect.sleep(transcriptPollInterval);
        }
        if (!turnLive(state, turn)) return;
        yield* finishTurn(
          state,
          turn,
          "failed",
          `Stopped waiting for Claude Cloud. It may still finish at https://claude.ai/code/${sessionId}.`,
        );
      });

      const runClaudeTurn = Effect.fn("CloudAdapterV2.runClaudeTurn")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
      ) {
        let sessions = options.claudeSessions;
        const model = turn.model && turn.model !== "cloud" ? turn.model : undefined;
        const { effort } = turn;
        const firstTurn = state.sessionId === null;
        const keepStoppedSession = Effect.fn("CloudAdapterV2.keepStoppedSession")(function* (
          stdout: string,
        ) {
          const created = parseClaudeCloudCreateOutput(stdout);
          if (created === null) return;
          state.sessionId = created.sessionId;
          state.claudeModel = model ?? null;
          state.claudeEffort = effort ?? null;
          state.claudeUltracode = false;
          yield* setStateThread(state, { nativeThreadRef: sessionRef(driver, created.sessionId) });
          if (sessions !== undefined)
            yield* sessions.interrupt(created.sessionId).pipe(Effect.ignore);
        });
        if (!firstTurn && sessions !== undefined) {
          const sessionId = state.sessionId ?? "";
          const transcript = sessions;
          const sent = yield* Effect.gen(function* () {
            const cursor = yield* transcript.latestCursor(sessionId);
            if (model !== undefined && model !== state.claudeModel) {
              yield* transcript.setModel(sessionId, model);
              state.claudeModel = model;
            }
            const settings = {
              ...(effort !== undefined && effort !== state.claudeEffort
                ? { effortLevel: effort }
                : {}),
              ...(turn.ultracode !== undefined && turn.ultracode !== state.claudeUltracode
                ? { ultracode: turn.ultracode }
                : {}),
            };
            if (Object.keys(settings).length > 0) {
              yield* transcript.applySettings(sessionId, settings);
              state.claudeEffort = effort ?? state.claudeEffort;
              state.claudeUltracode = turn.ultracode ?? state.claudeUltracode;
            }
            yield* transcript.sendMessage(sessionId, turn.prompt);
            return cursor;
          }).pipe(Effect.result);
          if (!turnLive(state, turn)) return;
          if (Result.isSuccess(sent))
            return yield* followClaudeTranscript(state, turn, transcript, sessionId, sent.success);
          if (!sent.failure.signedOut)
            return yield* finishTurn(
              state,
              turn,
              "failed",
              `Could not send to Claude Cloud: ${sent.failure.detail}`,
            );
          // Without a readable sign-in only the CLI can deliver the message.
          sessions = undefined;
        }
        const outcome = firstTurn
          ? yield* runner
              .runInPty({
                command: config.binaryPath,
                // The `=` form binds a prompt that starts with "-" as the value, not as a flag.
                args: [
                  `--cloud=${turn.prompt}`,
                  ...(model === undefined ? [] : ["--model", model]),
                  ...(effort === undefined ? [] : ["--effort", effort]),
                ],
                cwd,
                ...(spawnEnvironment === undefined ? {} : { environment: spawnEnvironment }),
              })
              .pipe(
                Effect.result,
                // Stop lets creation finish, so the session is recorded and stopped, not orphaned.
                Effect.tap((result) =>
                  Result.isSuccess(result) && turn.interrupted
                    ? keepStoppedSession(result.success.stdout)
                    : Effect.void,
                ),
                Effect.uninterruptible,
              )
          : yield* runner
              .run({
                command: config.binaryPath,
                args: [
                  "-p",
                  "--output-format",
                  "json",
                  `--cloud=${state.sessionId ?? ""}`,
                  "--",
                  turn.prompt,
                ],
                cwd,
                ...(spawnEnvironment === undefined ? {} : { environment: spawnEnvironment }),
              })
              .pipe(Effect.result);
        if (!turnLive(state, turn)) return;
        if (Result.isFailure(outcome)) {
          return yield* finishTurn(
            state,
            turn,
            "failed",
            `Claude Cloud submission failed: ${outcome.failure.detail}`,
          );
        }
        const { exitCode, stdout, stderr } = outcome.success;
        if (firstTurn) {
          const created = parseClaudeCloudCreateOutput(stdout);
          if (created === null || exitCode !== 0) {
            const tail = (stderr || stdout).trim().split(/\r?\n/u).slice(-3).join(" | ");
            return yield* finishTurn(
              state,
              turn,
              "failed",
              `Claude could not create the cloud session (exit ${exitCode}).${
                tail.length > 0 ? ` Output: ${tail}` : ""
              }`,
            );
          }
          state.sessionId = created.sessionId;
          state.claudeModel = model ?? null;
          state.claudeEffort = effort ?? null;
          yield* setStateThread(state, {
            nativeThreadRef: sessionRef(driver, created.sessionId),
          });
          if (!turnLive(state, turn)) return;
          yield* emitNotificationItem(
            state,
            turn,
            created.title === null
              ? "Started a Claude Cloud session"
              : `Started a Claude Cloud session: ${created.title}`,
            created.url ?? `https://claude.ai/code/${created.sessionId}`,
          );
          state.claudeUltracode = false;
          // The CLI takes no Ultracode flag at creation; the session accepts it right after.
          if (turn.ultracode === true && sessions !== undefined) {
            const applied = yield* sessions
              .applySettings(created.sessionId, { ultracode: true })
              .pipe(Effect.result);
            if (Result.isSuccess(applied)) state.claudeUltracode = true;
            else
              yield* emitNotificationItem(
                state,
                turn,
                "Ultracode is off for this session",
                `Claude Cloud did not accept it: ${applied.failure.detail}`,
              );
          }
        } else {
          const parsed = parseClaudeCloudFollowUpResponse(stdout);
          if (parsed === null || !parsed.ok || exitCode !== 0) {
            const tail = (stderr || stdout).trim().split(/\r?\n/u).slice(-3).join(" | ");
            return yield* finishTurn(
              state,
              turn,
              "failed",
              `Claude Cloud follow-up failed (exit ${exitCode}).${tail.length > 0 ? ` ${tail}` : ""}`,
            );
          }
        }
        if (!turnLive(state, turn)) return;
        if (sessions === undefined) return yield* finishWithoutTranscript(state, turn);
        yield* followClaudeTranscript(state, turn, sessions, state.sessionId ?? "", null);
      });

      const runNativeCodexTurn = Effect.fn("CloudAdapterV2.runNativeCodexTurn")(function* (
        state: CloudThreadState,
        turn: ActiveCloudTurn,
      ) {
        if (!options.nativeProtocol)
          return yield* finishTurn(state, turn, "failed", "Codex Cloud is not connected.");
        // Each thread runs in the environment of its own repository, never a default one.
        let environment = state.codexEnvironment;
        if (state.sessionId === null && environment === null) {
          const resolved = options.resolveEnvironment
            ? yield* options.resolveEnvironment(cwd).pipe(Effect.result)
            : null;
          if (!turnLive(state, turn)) return;
          if (resolved === null || Result.isFailure(resolved))
            return yield* finishTurn(
              state,
              turn,
              "failed",
              resolved === null
                ? "Set a Codex Cloud environment for this Codex account in Settings."
                : resolved.failure.message,
            );
          environment = resolved.success;
          state.codexEnvironment = environment;
        }
        const protocol = yield* options.nativeProtocol(cwd);
        turn.nativeProtocol = protocol;
        const signal = yield* Effect.abortSignal;
        const request = <A>(run: () => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) =>
              new CloudCliError({
                detail: cause instanceof Error ? cause.message : "Codex Cloud request failed.",
                cause,
              }),
          });
        if (state.sessionId === null) {
          const chosenEnvironment = environment ?? undefined;
          const warmed =
            options.warmThread && chosenEnvironment
              ? yield* options.warmThread.take(chosenEnvironment)
              : undefined;
          const prepared =
            warmed?.thread ??
            (yield* request(() =>
              protocol.prewarm(cloudNativeModel(turn.model), chosenEnvironment, signal),
            ));
          state.sessionId = prepared.id;
          yield* setStateThread(state, { nativeThreadRef: sessionRef(driver, prepared.id) });
          yield* Ref.update(providerSessionRef, (session) => ({
            ...session,
            model: prepared.model || session.model,
          }));
          if (warmed?.needsResume) yield* request(() => protocol.resume(prepared.id, signal));
        } else {
          yield* request(() => protocol.resume(state.sessionId!, signal));
        }
        const id = state.sessionId;
        const attached = yield* request(() => protocol.attach(id, signal));
        const model = cloudNativeModel(turn.model);
        // A warmed thread may have started on another model, so every turn names its own.
        const settings = {
          ...(model === undefined ? {} : { model }),
          ...(turn.effort === undefined ? {} : { effort: turn.effort }),
          ...(turn.serviceTier === undefined
            ? {}
            : { serviceTier: turn.serviceTier === "default" ? null : turn.serviceTier }),
        };
        turn.nativeTurnId = yield* request(() =>
          protocol.submit(id, `${turn.runId}:user`, turn.prompt, settings, signal),
        );
        turn.providerTurn = {
          ...turn.providerTurn,
          nativeTurnRef: sessionRef(driver, turn.nativeTurnId),
        };
        yield* emit({ type: "provider_turn.updated", driver, providerTurn: turn.providerTurn });
        const messages = new Map<string, string>();
        yield* Stream.fromAsyncIterable(
          attached,
          (cause) =>
            new CloudCliError({
              detail: cause instanceof Error ? cause.message : "Codex Cloud stream disconnected.",
              cause,
            }),
        ).pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "turn" && event.id === turn.nativeTurnId && event.status !== 4,
          ),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (!turnLive(state, turn)) return;
              if (event.type === "text") {
                const value = event.complete
                  ? event.text
                  : (messages.get(event.itemId) ?? "") + event.text;
                messages.set(event.itemId, value);
                yield* emitAssistantMessage(state, turn, value, {
                  id: event.itemId,
                  streaming: !event.complete,
                });
              } else if (event.type === "activity") {
                yield* emitNotificationItem(
                  state,
                  turn,
                  event.title || "Cloud command",
                  event.detail,
                );
              } else if (event.type === "files" && event.turnId === turn.nativeTurnId) {
                yield* emitCloudFiles(state, turn, event);
              } else if (event.type === "approval") {
                return yield* new CloudCliError({
                  detail:
                    "This cloud conversation needs approval. Open it in Codex to respond; T3 cannot answer cloud approvals yet.",
                });
              } else if (
                event.type === "turn" &&
                event.id === turn.nativeTurnId &&
                event.status !== 4
              ) {
                yield* finishTurn(
                  state,
                  turn,
                  event.status === 1 ? "completed" : event.status === 2 ? "interrupted" : "failed",
                  event.error || "Codex Cloud reported an unsupported terminal status.",
                );
              }
            }),
          ),
        );
        if (turnLive(state, turn))
          yield* finishTurn(
            state,
            turn,
            "failed",
            "The cloud stream disconnected before completion. The remote conversation may still be running; check Codex before resending.",
          );
      }, Effect.scoped);

      const startTurnInternal = Effect.fn("CloudAdapterV2.startTurn")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const state =
          threads.get(turnInput.threadId) ??
          (yield* ensureThreadState({
            threadId: turnInput.threadId,
            existingProviderThread: turnInput.providerThread,
          }));
        if (state.activeTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
            driver,
            threadId: turnInput.threadId,
            providerThreadId: state.providerThread.id,
            runId: turnInput.runId,
          });
        }
        const nativeTurnId = `${turnInput.runId}:turn:${turnInput.providerTurnOrdinal}`;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
          providerThreadId: state.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: weakRef(driver, nativeTurnId),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt: yield* DateTime.now,
          completedAt: null,
        };
        const turn: ActiveCloudTurn = {
          providerTurn,
          runId: turnInput.runId,
          runOrdinal: turnInput.runOrdinal,
          rootNodeId: turnInput.rootNodeId,
          prompt: turnInput.message.text,
          branch: turnInput.appThread.branch ?? null,
          model: turnInput.modelSelection.model,
          // Like local Codex, an unpicked level sends T3's default where it overrides the catalog's.
          effort:
            flavor === "codex"
              ? (getModelSelectionStringOptionValue(turnInput.modelSelection, "reasoningEffort") ??
                codexDefaultReasoningEffortOverride(turnInput.modelSelection.model))
              : getModelSelectionStringOptionValue(turnInput.modelSelection, "effort"),
          ultracode:
            flavor === "claude"
              ? getModelSelectionBooleanOptionValue(turnInput.modelSelection, "ultracode")
              : undefined,
          serviceTier:
            flavor === "codex"
              ? getCodexServiceTierOptionValue(turnInput.modelSelection)
              : undefined,
          nativeTurnId: null,
          nativeProtocol: null,
          fiber: null,
          interrupted: false,
          itemOrdinal: 0,
        };
        state.activeTurn = turn;
        yield* setStateThread(state, { status: "active" });
        yield* emit({ type: "provider_turn.updated", driver, providerTurn });
        yield* emit({
          type: "background_work.updated",
          driver,
          providerTurnId: providerTurn.id,
          pending: true,
        });
        const fiber = yield* (
          turnInput.message.attachments.length > 0
            ? finishTurn(
                state,
                turn,
                "failed",
                "Cloud machines cannot receive local attachments. Remove attachments before sending.",
              )
            : flavor === "claude"
              ? runClaudeTurn(state, turn)
              : runNativeCodexTurn(state, turn)
        ).pipe(
          Effect.catchCause((cause) =>
            finishTurn(
              state,
              turn,
              "failed",
              `The ${flavor === "claude" ? "Claude" : "Codex"} Cloud turn crashed: ${Cause.pretty(cause)}`,
            ).pipe(Effect.ignore),
          ),
          Effect.forkIn(scope),
        );
        turn.fiber = fiber;
      });

      const findStateByProviderThreadId = (providerThreadId: ProviderThreadId) =>
        [...threads.values()].find((candidate) => candidate.providerThread.id === providerThreadId);

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: yield* Ref.get(providerSessionRef),
        canResumeAfterRestart: false,
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          ensureThreadState({
            threadId: threadInput.threadId,
            existingProviderThread: threadInput.existingProviderThread,
          }).pipe(
            Effect.map((state) => state.providerThread),
            Effect.mapError(
              (cause): ProviderAdapter.ProviderAdapterEnsureThreadError =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: Effect.fn("CloudAdapterV2.resumeThread")(function* (resumeInput: {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly threadId?: ThreadId | undefined;
          readonly modelSelection?: ModelSelection | undefined;
          readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined;
        }) {
          return yield* Effect.gen(function* () {
            const state =
              findStateByProviderThreadId(resumeInput.providerThread.id) ??
              (resumeInput.threadId === undefined ? undefined : threads.get(resumeInput.threadId));
            if (state !== undefined) return state.providerThread;
            const threadId = resumeInput.threadId ?? resumeInput.providerThread.appThreadId;
            if (threadId === null) {
              return yield* new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: resumeInput.providerThread.id,
              });
            }
            return (yield* ensureThreadState({
              threadId,
              existingProviderThread: resumeInput.providerThread,
            })).providerThread;
          }).pipe(
            Effect.mapError(
              (cause): ProviderAdapter.ProviderAdapterResumeThreadError =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: resumeInput.providerThread.id,
                  cause,
                }),
            ),
          );
        }),
        startTurn: (turnInput) =>
          startTurnInternal(turnInput).pipe(
            Effect.mapError((cause): ProviderAdapter.ProviderAdapterTurnStartError =>
              cause._tag === "ProviderAdapterTurnStartError"
                ? cause
                : new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("CloudAdapterV2.interruptTurn")(function* (interruptInput) {
          const state = findStateByProviderThreadId(interruptInput.providerThread.id);
          const turn = state?.activeTurn ?? null;
          if (state === undefined || turn === null) return;
          if (turn.interrupted) return;
          turn.interrupted = true;
          // The remote stop is best effort; the local turn always ends.
          const nativeProtocol = turn.nativeProtocol;
          const nativeTurnId = turn.nativeTurnId;
          const sessionId = state.sessionId;
          if (nativeProtocol && nativeTurnId && sessionId) {
            yield* Effect.tryPromise({
              try: () => nativeProtocol.interrupt(sessionId, nativeTurnId),
              catch: (cause) =>
                new CloudCliError({ detail: "Could not interrupt the remote cloud turn.", cause }),
            }).pipe(Effect.ignore);
          }
          const claudeSessions = options.claudeSessions;
          if (flavor === "claude" && claudeSessions !== undefined && sessionId !== null) {
            yield* claudeSessions.interrupt(sessionId).pipe(Effect.ignore);
          }
          // The fiber may be finishing an uninterruptible session creation; Stop does not wait.
          if (turn.fiber !== null) {
            yield* Fiber.interrupt(turn.fiber).pipe(Effect.ignore, Effect.forkIn(scope));
          }
          yield* finishTurn(
            state,
            turn,
            "interrupted",
            flavor === "codex"
              ? "Interrupted locally. The cloud task may still be running; check the Codex Cloud dashboard."
              : "Interrupted.",
          );
        }),
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: Effect.fn("CloudAdapterV2.readThreadSnapshot")(
          (snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput) =>
            Effect.sync(() => {
              const state = findStateByProviderThreadId(snapshotInput.providerThread.id);
              return {
                providerThread: state?.providerThread ?? snapshotInput.providerThread,
                providerTurns: state?.turns ?? [],
                messages: state?.messages ?? [],
                runtimeRequests: [],
              };
            }),
        ),
        rollbackThread: Effect.fn("CloudAdapterV2.rollbackThread")(
          (rollbackInput: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver,
                providerThreadId: rollbackInput.providerThread.id,
              }),
            ),
        ),
        forkThread: Effect.fn("CloudAdapterV2.forkThread")(
          (forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver,
                providerThreadId: forkInput.sourceProviderThread.id,
              }),
            ),
        ),
      };
      return runtime;
    }),
  });
});
