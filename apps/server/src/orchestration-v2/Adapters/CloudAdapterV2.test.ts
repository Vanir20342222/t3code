import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";

import type { CloudCliRunner } from "../../provider/CloudCli.ts";
import { createCloudAdapterV2, type CloudAdapterV2Options } from "./CloudAdapterV2.ts";
import type { CodexCloudEvent } from "../../provider/CodexCloudProtocol.ts";
import {
  ClaudeCloudSessionError,
  type ClaudeCloudEventPage,
  type ClaudeCloudSessions,
} from "../../provider/ClaudeCloudSessions.ts";

const INSTANCE_ID = ProviderInstanceId.make("cloud-test");
const CODEX_CLOUD_DRIVER = ProviderDriverKind.make("codexCloud");
const CLAUDE_CLOUD_DRIVER = ProviderDriverKind.make("claudeCloud");
const THREAD_ID = ThreadId.make("thread-1");
const SESSION_ID = ProviderSessionId.make("provider-session-cloud-test");
const NOW = DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 12, 0, 0));

const modelSelection = {
  instanceId: INSTANCE_ID,
  model: "cloud",
} as const;

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/repo",
} as const;

const makeAppThread = (): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: "project-1" as OrchestrationV2AppThread["projectId"],
  title: "Cloud thread",
  providerInstanceId: INSTANCE_ID,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: THREAD_ID,
  },
  forkedFrom: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const makeRunner = (
  handler: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }>,
): CloudCliRunner => ({
  run: (input) => handler(input),
  runInPty: (input) => handler(input),
});

const buildAdapter = (options: {
  readonly driver: ProviderDriverKind;
  readonly flavor: "claude" | "codex";
  readonly runner: CloudCliRunner;
  readonly config?: {
    readonly environment?: string;
    readonly applyOnCompletion?: boolean;
    readonly requireSyncedBranch?: boolean;
    readonly unavailableReason?: string;
  };
  readonly pollInterval?: Duration.Input;
  readonly resolveEnvironment?: CloudAdapterV2Options["resolveEnvironment"];
  readonly claudeSessions?: ClaudeCloudSessions;
}) =>
  createCloudAdapterV2({
    instanceId: INSTANCE_ID,
    driver: options.driver,
    flavor: options.flavor,
    config: { binaryPath: "cloud-cli", ...options.config },
    runner: options.runner,
    ...(options.pollInterval === undefined ? {} : { pollInterval: options.pollInterval }),
    ...(options.resolveEnvironment ? { resolveEnvironment: options.resolveEnvironment } : {}),
    ...(options.claudeSessions ? { claudeSessions: options.claudeSessions } : {}),
  }).pipe(Effect.provide(IdAllocator.layer));

const drainUntilTerminal = (events: ProviderAdapterV2SessionRuntime["events"]) =>
  Effect.gen(function* () {
    const collected: ProviderAdapterV2Event[] = [];
    yield* Effect.gen(function* () {
      const queue = yield* Stream.toQueue(events, { capacity: "unbounded" });
      for (let index = 0; index < 64; index += 1) {
        const event = yield* Queue.take(queue);
        collected.push(event);
        if (event.type === "turn.terminal") break;
      }
    }).pipe(Effect.scoped);
    return collected;
  });

const startTurn = (
  runtime: ProviderAdapterV2SessionRuntime,
  options: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly runId: string;
    readonly runOrdinal: number;
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly model?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  },
) =>
  runtime.startTurn({
    appThread: makeAppThread(),
    threadId: THREAD_ID,
    runId: options.runId as never,
    runOrdinal: options.runOrdinal,
    providerTurnOrdinal: 1,
    attemptId: `${options.runId}-attempt` as never,
    rootNodeId: `${options.runId}-node` as never,
    providerThread: options.providerThread,
    message: {
      messageId: `${options.runId}-message` as never,
      text: options.text,
      attachments: options.attachments ?? [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: {
      ...modelSelection,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.options === undefined ? {} : { options: options.options }),
    },
    runtimePolicy,
  });

describe("CloudAdapterV2", () => {
  it.effect("runs in the project's environment, keeps one native thread, and reads replies", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const nativeProtocol = () =>
        Effect.succeed({
          prewarm: async () => {
            calls.push("prewarm");
            return { id: "native-thread", model: "real-model", cwd: "/workspace" };
          },
          resume: async (id: string) => {
            if (id !== "native-thread")
              throw new Error("Legacy environment IDs cannot resume native threads.");
            calls.push(`resume:${id}`);
            return Buffer.alloc(0);
          },
          submit: async (
            id: string,
            _messageId: string,
            _prompt: string,
            settings?: {
              readonly model?: string;
              readonly effort?: string;
              readonly serviceTier?: string | null;
            },
          ) => {
            const tier =
              settings?.serviceTier === null ? "standard" : (settings?.serviceTier ?? "-");
            calls.push(`submit:${id}:${settings?.model ?? "-"}:${settings?.effort ?? "-"}:${tier}`);
            return "native-turn";
          },
          interrupt: async () => Buffer.alloc(0),
          attach: async () =>
            (async function* (): AsyncGenerator<CodexCloudEvent> {
              yield {
                type: "text",
                itemId: `answer-${calls.length}`,
                text: "hello",
                complete: false,
              };
              yield {
                type: "text",
                itemId: `answer-${calls.length}`,
                text: " cloud",
                complete: false,
              };
              yield {
                type: "files",
                itemId: `patch-${calls.length}`,
                turnId: "native-turn",
                complete: false,
                changes: [
                  {
                    path: "/workspace/remote.ts",
                    diff: "@@ -1 +1 @@\n-old\n+new\n",
                    operation: "update",
                  },
                ],
              };
              yield { type: "turn", id: "native-turn", status: 1, error: "" };
            })(),
        });
      const adapter = yield* createCloudAdapterV2({
        instanceId: INSTANCE_ID,
        driver: CODEX_CLOUD_DRIVER,
        flavor: "codex",
        config: { binaryPath: "cloud-cli" },
        runner: makeRunner(() => Effect.die("Codex Cloud must not use the task CLI.")),
        resolveEnvironment: (cwd) =>
          Effect.sync(() => {
            calls.push(`environment:${cwd}`);
            return "env-repo";
          }),
        nativeProtocol,
        warmThread: {
          warm: () => Effect.void,
          take: (environment) =>
            Effect.sync(() => {
              calls.push(`take-warm-thread:${environment}`);
              return {
                thread: { id: "native-thread", model: "real-model", cwd: "/workspace" },
                needsResume: true,
              };
            }),
        },
      }).pipe(Effect.provide(IdAllocator.layer));
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection,
        runtimePolicy,
      });
      let providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      providerThread = {
        ...providerThread,
        nativeThreadRef: { driver: CODEX_CLOUD_DRIVER, nativeId: "default", strength: "strong" },
      };
      const turnIds = new Set<string>();
      for (const ordinal of [1, 2, 3]) {
        const reopened = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection,
          runtimePolicy,
        });
        providerThread = yield* reopened.ensureThread({
          threadId: THREAD_ID,
          existingProviderThread: providerThread,
          modelSelection,
          runtimePolicy,
        });
        yield* startTurn(reopened, {
          providerThread,
          runId: `native-${ordinal}`,
          runOrdinal: 1,
          text: "hello",
          // The first turn inherits the thread's settings, the second picks a level, and the
          // third gets T3's default for a model whose catalog default it overrides.
          ...(ordinal === 2
            ? {
                model: "gpt-6-luna",
                options: [
                  { id: "reasoningEffort", value: "xhigh" },
                  { id: "serviceTier", value: "priority" },
                ],
              }
            : ordinal === 3
              ? { model: "gpt-6-astra", options: [{ id: "serviceTier", value: "default" }] }
              : {}),
        });
        const events = yield* drainUntilTerminal(reopened.events);
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(events.filter((event) => event.type === "message.updated").at(-1)).toMatchObject({
          message: { text: "hello cloud", streaming: false },
        });
        expect(
          events
            .filter(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "file_change",
            )
            .at(-1),
        ).toMatchObject({
          turnItem: {
            type: "file_change",
            fileName: "/workspace/remote.ts",
            status: "completed",
            diffStr: "@@ -1 +1 @@\n-old\n+new\n",
          },
        });
        for (const event of events) {
          if (event.type === "provider_thread.updated") providerThread = event.providerThread;
          if (event.type === "turn.terminal") turnIds.add(event.providerTurnId);
        }
      }
      expect(turnIds.size).toBe(3);
      expect(calls).toEqual([
        // The thread warmed for this repository's environment; it idled, so it resumes first.
        "environment:/repo",
        "take-warm-thread:env-repo",
        "resume:native-thread",
        "submit:native-thread:-:-:-",
        "resume:native-thread",
        "submit:native-thread:gpt-6-luna:xhigh:priority",
        "resume:native-thread",
        "submit:native-thread:gpt-6-astra:medium:standard",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("a Codex Cloud turn fails with guidance when the repository has no environment", () =>
    Effect.gen(function* () {
      const adapter = yield* createCloudAdapterV2({
        instanceId: INSTANCE_ID,
        driver: CODEX_CLOUD_DRIVER,
        flavor: "codex",
        config: { binaryPath: "cloud-cli" },
        runner: makeRunner(() => Effect.die("Codex Cloud must not use the task CLI.")),
        resolveEnvironment: () => Effect.fail({ message: "This repository has no environment." }),
        nativeProtocol: () => Effect.die("No thread starts without an environment."),
      }).pipe(Effect.provide(IdAllocator.layer));
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      yield* startTurn(runtime, { providerThread, runId: "run-1", runOrdinal: 1, text: "hello" });
      const events = yield* drainUntilTerminal(runtime.events);
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "failed" });
      expect(JSON.stringify(events)).toContain("This repository has no environment.");
    }).pipe(Effect.scoped),
  );
  it.effect("claude first turn creates a session, records it, and completes the submission", () =>
    Effect.gen(function* () {
      const created = {
        exitCode: 0,
        stdout:
          "Created cloud session: Acknowledgment\nView: https://claude.ai/code/session_abc123\nResume with: claude --teleport session_abc123",
        stderr: "",
      };
      const ptyCalls: ReadonlyArray<string>[] = [];
      const runner = makeRunner((input) => {
        ptyCalls.push([input.command, ...input.args]);
        return Effect.succeed(created);
      });
      const adapter = yield* buildAdapter({
        driver: CLAUDE_CLOUD_DRIVER,
        flavor: "claude",
        runner,
      });
      const scope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });

      yield* startTurn(runtime, {
        providerThread,
        runId: "run-1",
        runOrdinal: 1,
        text: "Reply with the single word: ok",
      });

      const events = yield* drainUntilTerminal(runtime.events);
      const types = events.map((event) => event.type);
      expect(types).toContain("provider_turn.updated");
      expect(types).toContain("turn_item.updated");
      expect(types).toContain("turn.terminal");
      const terminal = events.at(-1);
      expect(terminal?.type === "turn.terminal" && terminal.status).toBe("completed");
      expect(ptyCalls.length).toBe(1);
      const notification = events.find((event) => event.type === "turn_item.updated");
      expect(
        notification?.type === "turn_item.updated" && notification.turnItem.type === "notification",
      ).toBe(true);

      // A follow-up goes through the non-interactive post path with the recorded session id.
      const postCalls: ReadonlyArray<string>[] = [];
      const followUpRunner = makeRunner((input) => {
        postCalls.push([input.command, ...input.args]);
        return Effect.succeed({
          exitCode: 0,
          stdout:
            '{"ok":true,"session_id":"session_abc123","url":"https://claude.ai/code/session_abc123"}',
          stderr: "",
        });
      });
      const followUpAdapter = yield* buildAdapter({
        driver: CLAUDE_CLOUD_DRIVER,
        flavor: "claude",
        runner: followUpRunner,
      });
      const followUpScope = yield* Scope.make();
      const followUpRuntime = yield* followUpAdapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, followUpScope));
      // Restarts adopt the projected thread: the native ref carries the session id.
      const restoredThread = {
        ...providerThread,
        nativeThreadRef: {
          driver: CLAUDE_CLOUD_DRIVER,
          nativeId: "session_abc123",
          strength: "strong",
        } as const,
      };
      yield* followUpRuntime.resumeThread({ providerThread: restoredThread });
      yield* startTurn(followUpRuntime, {
        providerThread: restoredThread,
        runId: "run-2",
        runOrdinal: 2,
        text: "continue",
      });
      const followUpEvents = yield* drainUntilTerminal(followUpRuntime.events);
      expect(postCalls.length).toBe(1);
      expect(postCalls[0]).toContain("--cloud=session_abc123");
      expect(followUpEvents.at(-1)?.type).toBe("turn.terminal");
      yield* Scope.close(followUpScope, Exit.void);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("stopping a Codex Cloud turn ends it even when the remote stop fails", () =>
    Effect.gen(function* () {
      let markAttached = () => {};
      const attached = new Promise<void>((resolve) => {
        markAttached = resolve;
      });
      const nativeProtocol = () =>
        Effect.succeed({
          prewarm: async () => ({ id: "native-thread", model: "real-model", cwd: "/workspace" }),
          resume: async () => Buffer.alloc(0),
          submit: async () => "native-turn",
          interrupt: async (): Promise<Buffer> => {
            throw new Error("network down");
          },
          attach: async () =>
            (async function* (): AsyncGenerator<CodexCloudEvent> {
              markAttached();
              yield* [];
              await new Promise<never>(() => {});
            })(),
        });
      const adapter = yield* createCloudAdapterV2({
        instanceId: INSTANCE_ID,
        driver: CODEX_CLOUD_DRIVER,
        flavor: "codex",
        config: { binaryPath: "cloud-cli", environment: "env-settings" },
        runner: makeRunner(() => Effect.die("The native path must not use the task CLI.")),
        nativeProtocol,
      }).pipe(Effect.provide(IdAllocator.layer));
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      yield* startTurn(runtime, { providerThread, runId: "run-1", runOrdinal: 1, text: "hello" });
      yield* Effect.promise(() => attached);
      yield* runtime.interruptTurn({ providerThread, providerTurnId: "provider-turn" as never });
      const events = yield* drainUntilTerminal(runtime.events);
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
    }).pipe(Effect.scoped),
  );
  it.effect("stopping Claude Cloud mid-creation keeps the new session for the next message", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const creating = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const runner = makeRunner((input) =>
        Effect.gen(function* () {
          calls.push(input.args[0] ?? "");
          yield* Deferred.succeed(creating, undefined);
          yield* Deferred.await(release);
          return {
            exitCode: 0,
            stdout: "Created cloud session: Task\nhttps://claude.ai/code/session_abc123",
            stderr: "",
          };
        }),
      );
      const claudeSessions: ClaudeCloudSessions = {
        latestCursor: () => Effect.succeed("1"),
        readEvents: (_sessionId, cursor) =>
          Effect.succeed({
            events: [{ type: "client_message" }, { type: "result", ok: true, text: "ok" }],
            cursor,
          }),
        setModel: () => Effect.void,
        applySettings: () => Effect.void,
        sendMessage: (_sessionId, text) =>
          Effect.sync(() => {
            calls.push(`send:${text}`);
          }),
        interrupt: (sessionId) =>
          Effect.sync(() => {
            calls.push(`interrupt:${sessionId}`);
          }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
      };
      const adapter = yield* buildAdapter({
        driver: CLAUDE_CLOUD_DRIVER,
        flavor: "claude",
        runner,
        claudeSessions,
        pollInterval: "0 seconds",
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      yield* startTurn(runtime, { providerThread, runId: "run-1", runOrdinal: 1, text: "first" });
      yield* Deferred.await(creating);
      yield* runtime.interruptTurn({ providerThread, providerTurnId: "provider-turn" as never });
      const first = yield* drainUntilTerminal(runtime.events);
      expect(first.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(stopped);
      yield* startTurn(runtime, { providerThread, runId: "run-2", runOrdinal: 2, text: "again" });
      const second = yield* drainUntilTerminal(runtime.events);
      expect(second.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      expect(calls).toEqual(["--cloud=first", "interrupt:session_abc123", "send:again"]);
    }).pipe(Effect.scoped),
  );
  it.effect("claude turns mirror the cloud transcript and switch models inside the session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let signedIn = true;
      const pages: ClaudeCloudEventPage[] = [
        {
          cursor: "6",
          events: [
            { type: "client_message" },
            { type: "tool", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            { type: "tool_result", id: "toolu_1", output: "README.md", isError: false },
            { type: "text", id: "a:0", text: "First reply" },
            { type: "result", ok: true, text: "First reply" },
          ],
        },
        {
          cursor: "12",
          events: [
            { type: "text", id: "late:0", text: "From an earlier turn" },
            { type: "client_message" },
            { type: "text", id: "b:0", text: "Second reply" },
            { type: "result", ok: true, text: "Second reply" },
          ],
        },
      ];
      const claudeSessions: ClaudeCloudSessions = {
        latestCursor: () =>
          signedIn
            ? Effect.sync(() => {
                calls.push("latest");
                return "6";
              })
            : Effect.fail(
                new ClaudeCloudSessionError({
                  detail: "signed out",
                  status: null,
                  signedOut: true,
                }),
              ),
        readEvents: (_sessionId, cursor) =>
          Effect.sync(() => {
            calls.push(`read:${cursor}`);
            return pages.shift() ?? { events: [], cursor };
          }),
        setModel: (_sessionId, model) =>
          Effect.sync(() => {
            calls.push(`model:${model}`);
          }),
        applySettings: (_sessionId, settings) =>
          Effect.sync(() => {
            calls.push(`settings:${JSON.stringify(settings)}`);
          }),
        sendMessage: (_sessionId, text) =>
          Effect.sync(() => {
            calls.push(`send:${text}`);
          }),
        interrupt: () => Effect.void,
      };
      const runner = makeRunner((input) => {
        calls.push(input.args.join(" "));
        return Effect.succeed(
          input.args[0]?.startsWith("--cloud=")
            ? {
                exitCode: 0,
                stdout: "Created cloud session: Task\nhttps://claude.ai/code/session_abc123",
                stderr: "",
              }
            : { exitCode: 0, stdout: '{"ok":true,"session_id":"session_abc123"}', stderr: "" },
        );
      });
      const adapter = yield* buildAdapter({
        driver: CLAUDE_CLOUD_DRIVER,
        flavor: "claude",
        runner,
        claudeSessions,
        pollInterval: "0 seconds",
      });
      const scope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      const messageTexts = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
        events.flatMap((event) => (event.type === "message.updated" ? [event.message.text] : []));

      yield* startTurn(runtime, {
        providerThread,
        runId: "run-1",
        runOrdinal: 1,
        text: "- list files",
        model: "claude-haiku-5-5",
        options: [
          { id: "effort", value: "high" },
          { id: "ultracode", value: true },
        ],
      });
      const first = yield* drainUntilTerminal(runtime.events);
      const command = first
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.type === "command_execution");
      expect(command).toMatchObject({ status: "completed", input: "ls", output: "README.md" });
      expect(messageTexts(first)).toEqual(["First reply"]);
      expect(first.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });

      yield* startTurn(runtime, {
        providerThread,
        runId: "run-2",
        runOrdinal: 2,
        text: "continue",
        model: "claude-sonnet-5-5",
        options: [
          { id: "effort", value: "max" },
          { id: "ultracode", value: true },
        ],
      });
      const second = yield* drainUntilTerminal(runtime.events);
      expect(messageTexts(second)).toEqual(["Second reply"]);
      expect(second.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      expect(calls).toEqual([
        "--cloud=- list files --model claude-haiku-5-5 --effort high",
        // Ultracode has no creation flag, so it follows once the session exists.
        'settings:{"ultracode":true}',
        "read:null",
        "latest",
        "model:claude-sonnet-5-5",
        'settings:{"effortLevel":"max"}',
        "send:continue",
        "read:6",
      ]);

      // Without a readable sign-in the CLI still sends the message, linking to the session.
      signedIn = false;
      yield* startTurn(runtime, {
        providerThread,
        runId: "run-3",
        runOrdinal: 3,
        text: "again",
        model: "claude-sonnet-5-5",
      });
      const third = yield* drainUntilTerminal(runtime.events);
      expect(messageTexts(third).join()).toContain("https://claude.ai/code/session_abc123");
      expect(third.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      expect(calls.at(-1)).toBe("-p --output-format json --cloud=session_abc123 -- again");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("provides a usable provider thread identity per app thread", () =>
    Effect.gen(function* () {
      const runner = makeRunner(() => Effect.die("unused"));
      const adapter = yield* buildAdapter({
        driver: CLAUDE_CLOUD_DRIVER,
        flavor: "claude",
        runner,
      });
      const scope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      expect(providerThread.appThreadId).toBe(THREAD_ID);
      expect(providerThread.driver).toBe(CLAUDE_CLOUD_DRIVER);
      expect(providerThread.nativeThreadRef?.strength).toBe("none");
      expect((yield* adapter.getCapabilities()).threads.canForkThread).toBe(false);
      const rejectedFork = yield* runtime
        .forkThread({ sourceProviderThread: providerThread, targetThreadId: ThreadId.make("fork") })
        .pipe(Effect.flip);
      expect(rejectedFork._tag).toBe("ProviderAdapterForkThreadError");
      yield* startTurn(runtime, {
        providerThread,
        runId: "attachment-run",
        runOrdinal: 1,
        text: "Read the attachment",
        attachments: [
          { type: "file", id: "file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 },
        ],
      });
      const events = yield* drainUntilTerminal(runtime.events);
      const terminal = events.at(-1);
      expect(
        terminal?.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("attachments"),
      ).toBe(true);
      // Minted from the app thread id, so a restart with the same app thread resolves back.
      expect(providerThread.id).toContain("native-thread:thread-1");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
