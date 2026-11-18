import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { CodexCloudSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { CloudCliError, type CloudCliRunner } from "./CloudCli.ts";
import { makeCodexCloudAccess } from "./CodexCloudAccess.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAuth = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tokens: Schema.Struct({ access_token: Schema.String, refresh_token: Schema.Null }),
    }),
  ),
);
const decodeConfig = Schema.decodeSync(CodexCloudSettings);

it.effect(
  "uses the source integration's managed credentials without copying refresh tokens or falling back to another login",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceInstanceId = ProviderInstanceId.make("source-account");
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", sourceInstanceId);
      const credentials = {
        clientId: "oaiapp_test",
        accessToken: "test-source-access",
        refreshToken: "test-source-refresh",
        expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "test-subject",
        email: null,
        idToken: "test-id-token",
      };
      yield* store.set(new TextEncoder().encode(yield* encodeJson(credentials)));
      let credentialPath = "";
      let fail = false;
      const run: CloudCliRunner["run"] = (command) =>
        Effect.gen(function* () {
          assert.strictEqual(command.environment?.OPENAI_API_KEY, undefined);
          assert.notStrictEqual(command.environment?.CODEX_HOME, "/another-account");
          credentialPath = `${command.environment?.CODEX_HOME}/auth.json`;
          const auth = yield* decodeAuth(yield* fs.readFileString(credentialPath));
          assert.strictEqual(auth.tokens.access_token, credentials.accessToken);
          assert.strictEqual(auth.tokens.refresh_token, null);
          assert.ok(!command.args.join(" ").includes(credentials.accessToken));
          return yield* fail
            ? Effect.fail(new CloudCliError({ detail: "test-failure" }))
            : Effect.succeed({ exitCode: 0, stdout: "{}", stderr: "" });
        }).pipe(
          Effect.mapError((cause) => new CloudCliError({ detail: "fixture-command", cause })),
        );
      const access = yield* makeCodexCloudAccess({
        sourceInstanceId,
        config: decodeConfig({ sourceSetupMode: "managed" }),
        environment: { CODEX_HOME: "/another-account", OPENAI_API_KEY: "test-wrong-account" },
        runner: { run, runInPty: run },
      });
      for (const shouldFail of [false, true]) {
        fail = shouldFail;
        const result = yield* access.runner
          .run({ command: "codex", args: ["cloud", "list", "--json"], cwd: process.cwd() })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, shouldFail ? "Failure" : "Success");
        assert.strictEqual(yield* fs.exists(credentialPath), false);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerSecretStore.layer),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-access-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        ),
      ),
    ),
);
