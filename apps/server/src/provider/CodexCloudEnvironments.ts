import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export class CodexCloudEnvironmentError extends Schema.TaggedError<CodexCloudEnvironmentError>()(
  "CodexCloudEnvironmentError",
  {
    reason: Schema.Literals(["authentication", "no-environment", "ambiguous", "network"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "authentication":
        return "The connected ChatGPT account could not access Codex Cloud. Reconnect that account in provider settings.";
      case "no-environment":
        return "This repository has no Codex Cloud environment yet. Create and publish one at https://chatgpt.com/codex, then retry; T3 will discover it automatically.";
      case "ambiguous":
        return "This repository has several Codex Cloud environments. Pin one in Codex Cloud, then retry.";
      case "network":
        return "Could not check Codex Cloud environments. Retry when the cloud service is available.";
    }
  }
}

const Environments = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    is_pinned: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  }),
);
const decodeEnvironments = Schema.decodeUnknownEffect(Environments);

export class CodexCloudEnvironments extends Context.Service<
  CodexCloudEnvironments,
  {
    readonly resolve: (input: {
      readonly accessToken: string;
      readonly accountId?: string | undefined;
      readonly repository: string;
    }) => Effect.Effect<string, CodexCloudEnvironmentError>;
  }
>()("t3/provider/CodexCloudEnvironments") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const resolve = Effect.fn("CodexCloudEnvironments.resolve")(function* (
    input: Parameters<CodexCloudEnvironments["Service"]["resolve"]>[0],
  ) {
    const segments = input.repository.split("/").map(encodeURIComponent).join("/");
    const response = yield* http
      .execute(
        HttpClientRequest.get(
          `https://chatgpt.com/backend-api/wham/environments/by-repo/github/${segments}`,
        ).pipe(
          HttpClientRequest.bearerToken(input.accessToken),
          HttpClientRequest.setHeaders(
            input.accountId ? { "ChatGPT-Account-Id": input.accountId } : {},
          ),
        ),
      )
      .pipe(Effect.mapError(() => new CodexCloudEnvironmentError({ reason: "network" })));
    if (response.status === 401 || response.status === 403)
      return yield* new CodexCloudEnvironmentError({ reason: "authentication" });
    if (response.status !== 200)
      return yield* new CodexCloudEnvironmentError({ reason: "network" });
    const environments = yield* response.json.pipe(
      Effect.flatMap(decodeEnvironments),
      Effect.mapError(() => new CodexCloudEnvironmentError({ reason: "network" })),
    );
    if (environments.length === 0)
      return yield* new CodexCloudEnvironmentError({ reason: "no-environment" });
    const pinned = environments.filter((environment) => environment.is_pinned);
    const chosen =
      environments.length === 1 ? environments[0] : pinned.length === 1 ? pinned[0] : undefined;
    if (!chosen) return yield* new CodexCloudEnvironmentError({ reason: "ambiguous" });
    return chosen.id;
  });
  return CodexCloudEnvironments.of({ resolve });
});

export const layer = Layer.effect(CodexCloudEnvironments, make);
