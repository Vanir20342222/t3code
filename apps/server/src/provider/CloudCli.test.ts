import { describe, expect, it } from "@effect/vitest";

import {
  cloudCliAuthenticated,
  collectCloudSubmission,
  parseClaudeCloudCreateOutput,
  parseClaudeCloudFollowUpResponse,
  unconfirmedSubmissionDetail,
} from "./CloudCli.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

it.effect(
  "finishes a confirmed cloud submission even when the interactive CLI stays attached",
  () =>
    Effect.gen(function* () {
      const result = yield* collectCloudSubmission({
        stdout: Stream.concat(
          Stream.make(
            new TextEncoder().encode(
              "Created cloud session: Test\nView: https://claude.ai/code/session_confirmed\n",
            ),
          ),
          Stream.never,
        ),
        stderr: Stream.never,
        exitCode: Effect.never,
      });
      expect(result.exitCode).toBe(0);
      expect(parseClaudeCloudCreateOutput(result.stdout)?.sessionId).toBe("session_confirmed");
    }),
);

// Captured from `claude --cloud ...` in a PTY before Claude Code's first-run setup.
const CLAUDE_FIRST_RUN_OUTPUT =
  "\u001b[?1004hWelcome\u001b[9Gto\u001b[12GClaude\u001b[19GCode\r\r\n\u001b[2GLet's\u001b[8Gget\u001b[12Gstarted.\r\r\n\u001b[2GChoose\u001b[9Gthe\u001b[13Gtext\u001b[18Gstyle\u001b[24Gthat\u001b[29Glooks\u001b[35Gbest\r\r\n";

const pendingChild = (output: string) => ({
  stdout: Stream.concat(Stream.make(new TextEncoder().encode(output)), Stream.never),
  stderr: Stream.never,
  exitCode: Effect.never,
});

it.effect("fails at once when Claude Code is still on its first-run setup", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(collectCloudSubmission(pendingChild(CLAUDE_FIRST_RUN_OUTPUT)));
    expect(error.detail).toContain("first-run setup");
  }),
);

it("names what the TUI last drew when submission is not confirmed in time", () => {
  expect(unconfirmedSubmissionDetail("\u001b[2GSelect\u001b[9Grepository\r\n")).toContain(
    "Last output: Select repository",
  );
  expect(unconfirmedSubmissionDetail("")).not.toContain("Last output");
});

it("accepts subscription CLI logins and rejects API keys, signed-out and malformed status", () => {
  for (const [flavor, stdout, expected] of [
    ["codex", "Logged in using ChatGPT", true],
    ["codex", "Logged in using an API key", false],
    ["claude", '{"loggedIn":true,"authMethod":"claude.ai"}', true],
    ["claude", '{"loggedIn":true,"authMethod":"api_key"}', false],
    ["claude", '{"loggedIn":false,"authMethod":"claude.ai"}', false],
    ["claude", "not json", false],
  ] as const) {
    expect(cloudCliAuthenticated(flavor, { stdout, stderr: "", exitCode: 0 })).toBe(expected);
    expect(cloudCliAuthenticated(flavor, { stdout, stderr: "", exitCode: 1 })).toBe(false);
  }
});

// Captured from `claude --cloud "Reply with the single word: ok"` inside a PTY
// (TUI frame noise included, as the adapter will actually see it).
const CLAUDE_CREATE_OUTPUT = [
  "7\u001b8Created cloud session: Acknowledgment",
  "View: https://claude.ai/code/session_01ExampleSession00000000?from=cli&m=0",
  "Resume with: claude --teleport session_01ExampleSession00000000",
  "\u001b(B\u001b[>4m\u001b[<u",
].join("\n");

const CLAUDE_FOLLOW_UP_OUTPUT =
  '{"ok":true,"session_id":"session_01ExampleSession00000000","url":"https://claude.ai/code/session_01ExampleSession00000000?from=cli&m=0"}';

describe("parseClaudeCloudCreateOutput", () => {
  it("extracts the session id, title, and url from TUI-framed output", () => {
    expect(parseClaudeCloudCreateOutput(CLAUDE_CREATE_OUTPUT)).toEqual({
      sessionId: "session_01ExampleSession00000000",
      title: "Acknowledgment",
      url: "https://claude.ai/code/session_01ExampleSession00000000?from=cli&m=0",
    });
  });

  it("returns null until the CLI itself names the new session", () => {
    expect(
      parseClaudeCloudCreateOutput("Attaching to an existing cloud session is not enabled."),
    ).toBe(null);
    expect(parseClaudeCloudCreateOutput("> why did session_abc123 fail?")).toBe(null);
  });

  it("accepts output where the title line is missing", () => {
    const parsed = parseClaudeCloudCreateOutput(
      "View: https://claude.ai/code/session_abc123?from=cli",
    );
    expect(parsed).toEqual({
      sessionId: "session_abc123",
      title: null,
      url: "https://claude.ai/code/session_abc123?from=cli",
    });
  });
});

describe("parseClaudeCloudFollowUpResponse", () => {
  it("parses the JSON response body", () => {
    expect(parseClaudeCloudFollowUpResponse(CLAUDE_FOLLOW_UP_OUTPUT)).toEqual({
      ok: true,
      sessionId: "session_01ExampleSession00000000",
      url: "https://claude.ai/code/session_01ExampleSession00000000?from=cli&m=0",
    });
  });

  it("returns null for non-JSON output", () => {
    expect(
      parseClaudeCloudFollowUpResponse("Error: --cloud cannot be combined with --print."),
    ).toBe(null);
  });

  it("returns null when the object lacks the session id", () => {
    expect(parseClaudeCloudFollowUpResponse('{"ok":true}')).toBe(null);
  });
});
