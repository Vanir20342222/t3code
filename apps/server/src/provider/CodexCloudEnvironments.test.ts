import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CodexCloudEnvironments from "./CodexCloudEnvironments.ts";

it.effect(
  "discovers only this repository's environment using the connected account and reports setup failures",
  () =>
    Effect.gen(function* () {
      for (const [status, body, expected] of [
        [200, [{ id: "env-project" }], "env-project"],
        [200, [{ id: "env-other" }, { id: "env-pinned", is_pinned: true }], "env-pinned"],
        [200, [], "no-environment"],
        [200, [{ id: "env-a" }, { id: "env-b" }], "ambiguous"],
        [403, {}, "authentication"],
        [503, {}, "network"],
      ] as const) {
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            assert.strictEqual(
              request.url,
              "https://chatgpt.com/backend-api/wham/environments/by-repo/github/acme/project",
            );
            assert.strictEqual(request.headers.authorization, "Bearer test-account-token");
            assert.strictEqual(request.headers["chatgpt-account-id"], "test-account");
            return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
          }),
        );
        const result = yield* Effect.gen(function* () {
          const service = yield* CodexCloudEnvironments.CodexCloudEnvironments;
          return yield* service
            .resolve({
              repository: "acme/project",
              accessToken: "test-account-token",
              accountId: "test-account",
            })
            .pipe(Effect.match({ onSuccess: (id) => id, onFailure: (error) => error.reason }));
        }).pipe(
          Effect.provide(CodexCloudEnvironments.layer),
          Effect.provideService(HttpClient.HttpClient, http),
        );
        assert.strictEqual(result, expected);
      }
    }),
);
