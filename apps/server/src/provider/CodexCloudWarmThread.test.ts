import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CloudCliError } from "./CloudCli.ts";
import { makeCodexCloudWarmThread } from "./CodexCloudWarmThread.ts";

const thread = { id: "warm-thread", model: "gpt-6-luna", cwd: "/workspace" };

it.effect(
  "starts one remote thread per pick, hands it over once to its own environment, and retries after a failure",
  () =>
    Effect.gen(function* () {
      const started: Array<string> = [];
      let fail = false;
      const ready = yield* Deferred.make<void>();
      const warm = yield* makeCodexCloudWarmThread((model, environment) =>
        Effect.gen(function* () {
          started.push(`${model ?? "-"}@${environment}`);
          yield* Deferred.await(ready);
          if (fail) return yield* new CloudCliError({ detail: "boot failed" });
          return thread;
        }),
      );

      yield* warm.warm("gpt-6-luna", "env-a");
      yield* warm.warm("gpt-6-sol", "env-a");
      yield* Deferred.succeed(ready, undefined);
      expect(yield* warm.take("env-b")).toBeUndefined();
      expect(yield* warm.take("env-a")).toEqual({ thread, needsResume: false });
      expect(started).toEqual(["gpt-6-luna@env-a"]);
      expect(yield* warm.take("env-a")).toBeUndefined();

      fail = true;
      yield* warm.warm(undefined, "env-a");
      expect(yield* warm.take("env-a")).toBeUndefined();
      fail = false;
      yield* warm.warm(undefined, "env-a");
      yield* TestClock.adjust("4 minutes");
      expect(yield* warm.take("env-a")).toEqual({ thread, needsResume: true });
      expect(started).toEqual(["gpt-6-luna@env-a", "-@env-a", "-@env-a"]);
    }).pipe(Effect.scoped),
);
