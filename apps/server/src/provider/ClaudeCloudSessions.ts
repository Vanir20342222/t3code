import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Reads and steers Claude Cloud sessions through the same session-events API
 * `claude --teleport` uses, authenticated with the CLI's own claude.ai sign-in.
 * Session creation stays in the CLI, which owns repo and environment setup.
 */

const API_ORIGIN = "https://api.anthropic.com";

export type ClaudeCloudEvent =
  | { readonly type: "client_message" }
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: "result"; readonly ok: boolean; readonly text: string | null };

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
};

/** Session events carry Claude Code stream-json frames; `source` says who wrote them. */
export function translateClaudeCloudEvent(envelope: unknown): ClaudeCloudEvent[] {
  const record = asRecord(envelope);
  const payload = asRecord(record?.payload);
  if (record === null || payload === null) return [];
  const message = asRecord(payload.message);
  const uuid = typeof payload.uuid === "string" ? payload.uuid : String(record.sequence_num ?? "");
  switch (payload.type) {
    case "user": {
      if (record.source === "client") return [{ type: "client_message" }];
      if (!Array.isArray(message?.content)) return [];
      return message.content.flatMap((block): ClaudeCloudEvent[] => {
        const part = asRecord(block);
        if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") return [];
        return [
          {
            type: "tool_result",
            id: part.tool_use_id,
            output: toolResultText(part.content),
            isError: part.is_error === true,
          },
        ];
      });
    }
    case "assistant": {
      if (!Array.isArray(message?.content)) return [];
      return message.content.flatMap((block, index): ClaudeCloudEvent[] => {
        const part = asRecord(block);
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
          return [{ type: "text", id: `${uuid}:${index}`, text: part.text }];
        if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim())
          return [{ type: "reasoning", id: `${uuid}:${index}`, text: part.thinking }];
        if (part?.type === "tool_use" && typeof part.id === "string")
          return [
            {
              type: "tool",
              id: part.id,
              name: typeof part.name === "string" ? part.name : "tool",
              input: asRecord(part.input) ?? {},
            },
          ];
        return [];
      });
    }
    case "result":
      return [
        {
          type: "result",
          ok: payload.subtype === "success" && payload.is_error !== true,
          text: typeof payload.result === "string" ? payload.result : null,
        },
      ];
    default:
      return [];
  }
}

export class ClaudeCloudSessionError extends Schema.TaggedError<ClaudeCloudSessionError>()(
  "ClaudeCloudSessionError",
  {
    detail: Schema.String,
    status: Schema.NullOr(Schema.Number),
    /** No readable claude.ai sign-in here, such as a keychain-only one on macOS. */
    signedOut: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ClaudeCloudEventPage {
  readonly events: ReadonlyArray<ClaudeCloudEvent>;
  /** Pass back to read only newer events. */
  readonly cursor: string | null;
}

export interface ClaudeCloudSessions {
  /** The newest event cursor, so a following read returns only what comes after. */
  readonly latestCursor: (
    sessionId: string,
  ) => Effect.Effect<string | null, ClaudeCloudSessionError>;
  readonly readEvents: (
    sessionId: string,
    cursor: string | null,
  ) => Effect.Effect<ClaudeCloudEventPage, ClaudeCloudSessionError>;
  readonly setModel: (
    sessionId: string,
    model: string,
  ) => Effect.Effect<void, ClaudeCloudSessionError>;
  /** Remote Control accepts only these two settings; the CLI refuses the rest. */
  readonly applySettings: (
    sessionId: string,
    settings: { readonly effortLevel?: string; readonly ultracode?: boolean },
  ) => Effect.Effect<void, ClaudeCloudSessionError>;
  /** Posts a prompt as the CLI's `-p --cloud <id>` does, without its seconds of startup. */
  readonly sendMessage: (
    sessionId: string,
    text: string,
  ) => Effect.Effect<void, ClaudeCloudSessionError>;
  readonly interrupt: (sessionId: string) => Effect.Effect<void, ClaudeCloudSessionError>;
}

const decodeCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({ accessToken: Schema.NonEmptyString }),
    }),
  ),
);

export const makeClaudeCloudSessions = Effect.fn("ClaudeCloudSessions.make")(function* (input: {
  /** CLAUDE_CONFIG_DIR, or ~/.claude. */
  readonly configDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const credentialsPath = path.join(input.configDir, ".credentials.json");

  // Read on every call: the CLI refreshes this file whenever it runs.
  const accessToken = fs.readFileString(credentialsPath).pipe(
    Effect.mapError(
      () =>
        new ClaudeCloudSessionError({
          detail: "Claude Code's sign-in file was not found, so cloud replies cannot be read here.",
          status: null,
          signedOut: true,
        }),
    ),
    Effect.flatMap((raw) => {
      const credentials = decodeCredentials(raw);
      return credentials._tag === "Some"
        ? Effect.succeed(credentials.value.claudeAiOauth.accessToken)
        : Effect.fail(
            new ClaudeCloudSessionError({
              detail: "Claude Code is not signed in with claude.ai.",
              status: null,
              signedOut: true,
            }),
          );
    }),
  );

  const send = Effect.fn("ClaudeCloudSessions.send")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* accessToken;
    const response = yield* http
      .execute(
        request.pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new ClaudeCloudSessionError({ detail: "Could not reach Claude Cloud.", status: null }),
        ),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new ClaudeCloudSessionError({
        detail:
          response.status === 401
            ? "The Claude sign-in expired. Run `claude` once to refresh it."
            : `Claude Cloud returned HTTP ${response.status}.`,
        status: response.status,
      });
    return asRecord(
      yield* response.json.pipe(
        Effect.mapError(
          () =>
            new ClaudeCloudSessionError({
              detail: "Claude Cloud returned an unreadable response.",
              status: response.status,
            }),
        ),
      ),
    );
  });

  // The CLI prints `session_…` ids; the events API names the same session `cse_…`.
  const eventsUrl = (sessionId: string) =>
    `${API_ORIGIN}/v1/code/sessions/${encodeURIComponent(sessionId.replace(/^session_/u, "cse_"))}/events`;

  const postEvent = Effect.fn("ClaudeCloudSessions.postEvent")(function* (
    sessionId: string,
    payload: UnknownRecord & { readonly type: string },
  ) {
    const event = { uuid: SecureRandom.uuidV4Unsafe(), ...payload };
    yield* send(
      HttpClientRequest.post(eventsUrl(sessionId)).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          events: [{ event_type: event.type, payload: event }],
        }),
      ),
    );
  });

  const controlRequest = Effect.fn("ClaudeCloudSessions.controlRequest")(function* (
    sessionId: string,
    request: UnknownRecord,
  ) {
    yield* postEvent(sessionId, {
      type: "control_request",
      request_id: SecureRandom.uuidV4Unsafe(),
      request,
    });
  });

  return {
    latestCursor: Effect.fn("ClaudeCloudSessions.latestCursor")(function* (sessionId: string) {
      const page = yield* send(
        HttpClientRequest.get(eventsUrl(sessionId), {
          urlParams: { sort_order: "desc", limit: "1" },
        }),
      );
      const newest = Array.isArray(page?.data) ? asRecord(page.data[0]) : null;
      return newest?.sequence_num === undefined ? null : String(newest.sequence_num);
    }),
    readEvents: Effect.fn("ClaudeCloudSessions.readEvents")(function* (
      sessionId: string,
      cursor: string | null,
    ) {
      const events: ClaudeCloudEvent[] = [];
      let next = cursor;
      for (let page = 0; page < 20; page += 1) {
        const body = yield* send(
          HttpClientRequest.get(eventsUrl(sessionId), {
            urlParams: {
              sort_order: "asc",
              limit: "200",
              ...(next === null ? {} : { cursor: next }),
            },
          }),
        );
        const data = Array.isArray(body?.data) ? body.data : [];
        for (const entry of data) {
          const sequence = asRecord(entry)?.sequence_num;
          if (sequence !== undefined) next = String(sequence);
          events.push(...translateClaudeCloudEvent(entry));
        }
        if (typeof body?.next_cursor !== "string" || data.length === 0) break;
        next = body.next_cursor;
      }
      return { events, cursor: next } satisfies ClaudeCloudEventPage;
    }),
    setModel: (sessionId: string, model: string) =>
      controlRequest(sessionId, { subtype: "set_model", model }),
    applySettings: (sessionId, settings) =>
      controlRequest(sessionId, { subtype: "apply_flag_settings", settings }),
    sendMessage: (sessionId: string, text: string) =>
      postEvent(sessionId, {
        type: "user",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: text },
      }),
    interrupt: (sessionId: string) => controlRequest(sessionId, { subtype: "interrupt" }),
  } satisfies ClaudeCloudSessions;
});
