import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Option from "effect/Option";

import { makeClaudeCloudSessions, translateClaudeCloudEvent } from "./ClaudeCloudSessions.ts";

it.each([
  [
    "a prompt written by a client",
    { source: "client", payload: { type: "user", message: { content: "hi" } } },
    [{ type: "client_message" }],
  ],
  [
    "a tool result written by the worker",
    {
      source: "worker",
      payload: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: true,
              content: [{ type: "text", text: "exit 1" }],
            },
          ],
        },
      },
    },
    [{ type: "tool_result", id: "toolu_1", output: "exit 1", isError: true }],
  ],
  [
    "assistant text, thinking, and a tool call",
    {
      source: "worker",
      payload: {
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            { type: "thinking", thinking: "plan", signature: "x" },
            { type: "text", text: "Done." },
            { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
            { type: "thinking", thinking: "", signature: "redacted" },
          ],
        },
      },
    },
    [
      { type: "reasoning", id: "u1:0", text: "plan" },
      { type: "text", id: "u1:1", text: "Done." },
      { type: "tool", id: "toolu_2", name: "Bash", input: { command: "ls" } },
    ],
  ],
  [
    "a failed result",
    { payload: { type: "result", subtype: "error_during_execution", is_error: true } },
    [{ type: "result", ok: false, text: null }],
  ],
  ["session bookkeeping", { payload: { type: "rate_limit_event" } }, []],
])("translates %s", (_name, envelope, expected) => {
  expect(translateClaudeCloudEvent(envelope)).toEqual(expected);
});

const makeSessions = (
  token: string | null,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "claude-cloud-" });
    if (token !== null)
      yield* fs.writeFileString(
        path.join(configDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      );
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const sessions = yield* makeClaudeCloudSessions({ configDir }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request);
            return HttpClientResponse.fromWeb(request, respond(request));
          }),
        ),
      ),
    );
    return { sessions, requests };
  });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it.layer(NodeServices.layer)("ClaudeCloudSessions", (it) => {
  it.effect("reads pages after a cursor and posts model switches as control requests", () =>
    Effect.gen(function* () {
      const pages = [
        {
          data: [{ sequence_num: "8", source: "client", payload: { type: "user" } }],
          next_cursor: "8",
        },
        {
          data: [
            { sequence_num: "9", payload: { type: "result", subtype: "success", result: "ok" } },
          ],
          next_cursor: null,
        },
      ];
      const { sessions, requests } = yield* makeSessions("token-1", (request) =>
        json(request.method === "POST" ? { results: [] } : pages.shift()),
      );

      expect(yield* sessions.readEvents("session_abc", "7")).toEqual({
        events: [{ type: "client_message" }, { type: "result", ok: true, text: "ok" }],
        cursor: "9",
      });
      expect(
        requests.map((request) =>
          Option.getOrNull(UrlParams.getFirst(request.urlParams, "cursor")),
        ),
      ).toEqual(["7", "8"]);
      expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/code/sessions/cse_abc/events");
      expect(requests[0]?.headers.authorization).toBe("Bearer token-1");

      yield* sessions.setModel("session_abc", "claude-sonnet-5-5");
      const body = requests.at(-1)?.body;
      const posted = JSON.parse(
        body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "{}",
      );
      expect(posted.events[0]).toMatchObject({
        event_type: "control_request",
        payload: {
          type: "control_request",
          request: { subtype: "set_model", model: "claude-sonnet-5-5" },
        },
      });

      yield* sessions.applySettings("session_abc", { effortLevel: "max", ultracode: true });
      const effortBody = requests.at(-1)?.body;
      expect(
        JSON.parse(
          effortBody?._tag === "Uint8Array" ? new TextDecoder().decode(effortBody.body) : "{}",
        ).events[0].payload.request,
      ).toEqual({
        subtype: "apply_flag_settings",
        settings: { effortLevel: "max", ultracode: true },
      });

      yield* sessions.sendMessage("session_abc", "continue");
      const messageBody = requests.at(-1)?.body;
      expect(
        JSON.parse(
          messageBody?._tag === "Uint8Array" ? new TextDecoder().decode(messageBody.body) : "{}",
        ).events[0],
      ).toMatchObject({
        event_type: "user",
        payload: {
          type: "user",
          session_id: "session_abc",
          parent_tool_use_id: null,
          message: { role: "user", content: "continue" },
        },
      });
    }),
  );

  it.effect("reports an expired sign-in by status and a missing one before any request", () =>
    Effect.gen(function* () {
      const expired = yield* makeSessions("stale", () => json({}, 401));
      const expiredError = yield* Effect.flip(expired.sessions.latestCursor("session_abc"));
      expect(expiredError.status).toBe(401);

      const signedOut = yield* makeSessions(null, () => json({}));
      const signedOutError = yield* Effect.flip(signedOut.sessions.latestCursor("session_abc"));
      expect(signedOutError.status).toBeNull();
      expect(signedOut.requests).toEqual([]);
    }),
  );
});
