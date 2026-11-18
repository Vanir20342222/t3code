import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Bridge to the provider CLIs' cloud surfaces: Codex Cloud tasks through
 * `codex cloud` subcommands, Claude Cloud sessions through `claude --cloud`
 * and `claude -p --cloud <session>` for follow-ups. Both ride the user's
 * existing sign-in; neither CLI streams the remote transcript back.
 */

export class CloudCliError extends Schema.TaggedError<CloudCliError>()("CloudCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface CloudCommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function cloudCliAuthenticated(
  flavor: "codex" | "claude",
  outcome: CloudCommandOutcome,
): boolean {
  if (outcome.exitCode !== 0) return false;
  if (flavor === "codex") return /Logged in using ChatGPT/iu.test(outcome.stdout + outcome.stderr);
  try {
    const status = asRecord(JSON.parse(outcome.stdout));
    return (
      status?.loggedIn === true &&
      (status.authMethod === "claude.ai" || status.authMethod === "oauth")
    );
  } catch {
    return false;
  }
}

export interface CloudCliRunner {
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<CloudCommandOutcome, CloudCliError>;
  /** Runs the command attached to a pseudo-TTY and returns its captured output. */
  readonly runInPty: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<CloudCommandOutcome, CloudCliError>;
}

// Escapes become spaces: the TUI draws word gaps with cursor moves, not space characters.
const TERMINAL_ESCAPE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/gu;
const visibleTerminalText = (output: string) =>
  output.replace(TERMINAL_ESCAPE, " ").replace(/\s+/gu, " ").trim();

const FIRST_RUN_SETUP_DETAIL =
  "Claude Code has not finished its first-run setup on this machine, so it cannot start a cloud session. Run `claude` once in a terminal here, finish setup, then send again.";

/** Claude Code's first launch opens a theme picker that no cloud submission can get past. */
const awaitsClaudeFirstRunSetup = (output: string): boolean =>
  visibleTerminalText(output).replace(/\s+/gu, "").toLowerCase().includes("choosethetextstyle");

export const unconfirmedSubmissionDetail = (output: string): string => {
  const tail = visibleTerminalText(output).slice(-240);
  return `Claude Cloud did not confirm submission in time. Check claude.ai/code before retrying to avoid creating a duplicate session.${
    tail.length > 0 ? ` Last output: ${tail}` : ""
  }`;
};

export const collectCloudSubmission = Effect.fn("CloudCli.collectCloudSubmission")(function* (
  child: Pick<ChildProcessSpawner.ChildProcessHandle, "stdout" | "stderr" | "exitCode">,
  timeout: Duration.Input = "30 seconds",
) {
  const ready = yield* Deferred.make<CloudCommandOutcome, CloudCliError>();
  const output = yield* Ref.make("");
  const reader = yield* Stream.merge(child.stdout, child.stderr).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.updateAndGet(output, (value) => (value + chunk).slice(-256_000)).pipe(
        Effect.flatMap((stdout) =>
          parseClaudeCloudCreateOutput(stdout)
            ? Deferred.succeed(ready, { exitCode: 0, stdout, stderr: "" })
            : awaitsClaudeFirstRunSetup(stdout)
              ? Deferred.fail(ready, new CloudCliError({ detail: FIRST_RUN_SETUP_DETAIL }))
              : Effect.void,
        ),
      ),
    ),
    Effect.catch((cause) =>
      Deferred.fail(
        ready,
        new CloudCliError({ detail: "Could not read the Claude Cloud submission.", cause }),
      ),
    ),
    Effect.forkScoped,
  );
  const exited = child.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Fiber.join(reader).pipe(
        Effect.andThen(Ref.get(output)),
        Effect.map((stdout) => ({ exitCode, stdout, stderr: "" })),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new CloudCliError({ detail: "Could not read the Claude Cloud submission.", cause }),
    ),
  );
  const timedOut = Effect.sleep(timeout).pipe(
    Effect.andThen(Ref.get(output)),
    Effect.flatMap((stdout) =>
      Effect.fail(new CloudCliError({ detail: unconfirmedSubmissionDetail(stdout) })),
    ),
  );
  return yield* Effect.raceFirst(Deferred.await(ready), Effect.raceFirst(exited, timedOut));
}, Effect.scoped);

export const makeSpawnCloudCliRunner = Effect.fn("CloudCli.makeSpawnCloudCliRunner")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const runProcess = Effect.fn("CloudCli.runProcess")(function* (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, [...input.args], {
        cwd: input.cwd,
        ...(input.environment === undefined ? {} : { env: input.environment }),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout, stderr } satisfies CloudCommandOutcome;
  }, Effect.scoped);
  const runGuarded = Effect.fn("CloudCli.runGuarded")(function* (
    input: Parameters<typeof runProcess>[0],
  ) {
    return yield* runProcess(input).pipe(
      Effect.catch(
        (error) =>
          new CloudCliError({
            detail: `Failed to run ${input.command}: ${error.message ?? String(error)}`,
            cause: error,
          }),
      ),
    );
  });

  // `script` flag syntax differs: util-linux takes the command as one shell
  // string, the BSD variant takes it as raw argv.
  const ptyRunnerFor = (platform: NodeJS.Platform) =>
    platform === "darwin"
      ? (input: { readonly command: string; readonly args: ReadonlyArray<string> }) => ({
          command: "script",
          args: ["-q", "/dev/null", input.command, ...input.args] as ReadonlyArray<string>,
        })
      : (input: { readonly command: string; readonly args: ReadonlyArray<string> }) => ({
          command: "script",
          args: ["-qec", shellQuote(input.command, input.args), "/dev/null"],
        });

  const shellQuote = (command: string, args: ReadonlyArray<string>): string =>
    [command, ...args].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");

  return {
    run: runGuarded,
    runInPty: Effect.fn("CloudCli.runInPty")(function* (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
      readonly environment?: NodeJS.ProcessEnv;
    }) {
      const wrapped = ptyRunnerFor(platform)({ command: input.command, args: input.args });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(wrapped.command, [...wrapped.args], {
            cwd: input.cwd,
            ...(input.environment === undefined ? {} : { env: input.environment }),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new CloudCliError({
                detail: `Failed to run ${input.command}: ${cause.message}`,
                cause,
              }),
          ),
        );
      return yield* collectCloudSubmission(child);
    }, Effect.scoped),
  } satisfies CloudCliRunner;
});

// Only the CLI's own lines name the new session; the echoed prompt may mention another one.
const CREATED_SESSION_ID_PATTERN =
  /(?:claude\.ai\/code\/|claude --teleport )(session_[0-9A-Za-z]+)/u;
const CREATED_SESSION_PATTERN = /Created cloud session:\s*(.+)/u;

export interface ClaudeCloudSessionCreated {
  readonly sessionId: string;
  readonly title: string | null;
  readonly url: string | null;
}

/**
 * `claude --cloud "<description>"` prints, inside TUI framing:
 * "Created cloud session: <title>", a claude.ai/code/<session_id> URL, and
 * "Resume with: claude --teleport <session_id>".
 */
export function parseClaudeCloudCreateOutput(output: string): ClaudeCloudSessionCreated | null {
  const sessionId = CREATED_SESSION_ID_PATTERN.exec(output)?.[1];
  if (sessionId === undefined) return null;
  const title = CREATED_SESSION_PATTERN.exec(output)?.[1]?.trim() ?? null;
  const url = /https:\/\/claude\.ai\/code\/\S+/u.exec(output)?.[0]?.trim() ?? null;
  return { sessionId, title, url };
}

export interface ClaudeCloudFollowUpResponse {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly url: string | null;
}

/** `claude -p "<message>" --output-format json --cloud <session id>` prints one JSON object. */
export function parseClaudeCloudFollowUpResponse(
  stdout: string,
): ClaudeCloudFollowUpResponse | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  const end = stdout.lastIndexOf("}");
  if (end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      "session_id" in parsed &&
      typeof parsed.session_id === "string"
    ) {
      return {
        ok: parsed.ok === true,
        sessionId: parsed.session_id,
        url: "url" in parsed && typeof parsed.url === "string" ? (parsed.url as string) : null,
      };
    }
  } catch {
    // Fall through to null.
  }
  return null;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
