import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { CloudCliError } from "./CloudCli.ts";

export interface CodexCloudPrewarmedThread {
  readonly id: string;
  readonly model: string;
  readonly cwd: string;
}

// An unused thread past this is left behind; one older than the resume threshold may have idled.
const WARM_THREAD_TTL_MS = 15 * 60_000;
const RESUME_WARM_THREAD_AFTER_MS = 3 * 60_000;

export interface CodexCloudWarmThread {
  /** Starts creating a remote thread in an environment unless one there is starting or fresh. */
  readonly warm: (model: string | undefined, environment: string) => Effect.Effect<void>;
  /** Hands over a thread warmed in this environment once, waiting while it starts. */
  readonly take: (
    environment: string,
  ) => Effect.Effect<
    { readonly thread: CodexCloudPrewarmedThread; readonly needsResume: boolean } | undefined
  >;
}

/**
 * Creating a Codex Cloud thread boots its container, about half a minute. Warming starts that
 * when the user picks Codex Cloud, so the first message finds a thread ready.
 */
export const makeCodexCloudWarmThread = Effect.fn("CodexCloudWarmThread.make")(function* (
  prewarm: (
    model: string | undefined,
    environment: string,
  ) => Effect.Effect<CodexCloudPrewarmedThread, CloudCliError>,
) {
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const slot = yield* Ref.make<{
    readonly fiber: Fiber.Fiber<CodexCloudPrewarmedThread, CloudCliError>;
    readonly startedAt: number;
    readonly environment: string;
  } | null>(null);

  const warm = Effect.fn("CodexCloudWarmThread.warm")(function* (
    model: string | undefined,
    environment: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(slot);
    if (
      current !== null &&
      current.environment === environment &&
      now - current.startedAt < WARM_THREAD_TTL_MS
    )
      return;
    const fiber = yield* prewarm(model, environment).pipe(
      // A failed warm-up leaves the slot free, so the next pick or message starts over.
      Effect.tapError((error) =>
        Ref.set(slot, null).pipe(
          Effect.andThen(Effect.logWarning("Codex Cloud warm-up failed", error.detail)),
        ),
      ),
      Effect.forkIn(scope),
    );
    yield* Ref.set(slot, { fiber, startedAt: now, environment });
  }, lock.withPermits(1));

  const take = Effect.fn("CodexCloudWarmThread.take")(function* (environment: string) {
    // A thread warmed for another project's environment stays for that project.
    const current = yield* lock.withPermits(1)(
      Ref.modify(slot, (current) =>
        current?.environment === environment ? [current, null] : [null, current],
      ),
    );
    if (current === null) return undefined;
    const age = (yield* Clock.currentTimeMillis) - current.startedAt;
    if (age >= WARM_THREAD_TTL_MS) return undefined;
    const exit = yield* Fiber.await(current.fiber);
    return Exit.isSuccess(exit)
      ? { thread: exit.value, needsResume: age >= RESUME_WARM_THREAD_AFTER_MS }
      : undefined;
  });

  return { warm, take } satisfies CodexCloudWarmThread;
});
