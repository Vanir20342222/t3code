import {
  type CodexCloudSettings,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as CodexSchema from "effect-codex-app-server/schema";
import { parseGitRemoteRepository } from "@t3tools/shared/git";
import { CloudCliError, type CloudCliRunner } from "./CloudCli.ts";
import { parseCodexModelListResponse, withCodexAppServerClient } from "./CodexProvider.ts";
import { makeCodexCloudProtocol } from "./CodexCloudProtocol.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import * as CodexCloudEnvironments from "./CodexCloudEnvironments.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as ServerConfig from "../config.ts";

const isCloudCliError = Schema.is(CloudCliError);
const encodeCloudAuth = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.Literal("chatgpt"),
      tokens: Schema.Struct({
        id_token: Schema.String,
        access_token: Schema.String,
        refresh_token: Schema.Null,
        account_id: Schema.NullOr(Schema.String),
      }),
    }),
  ),
);
const decodeClaims = Schema.decodeUnknownOption(
  Schema.Struct({
    exp: Schema.optionalKey(Schema.Number),
    "https://api.openai.com/auth": Schema.optionalKey(
      Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
    ),
  }),
);

const tokenClaims = (token: string) => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return Option.getOrUndefined(
      decodeClaims(JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")))),
    );
  } catch {
    return undefined;
  }
};

const accountIdFromToken = (token: string): string | undefined =>
  tokenClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;

// Reading a fresh token starts a Codex app-server, about a second per turn; reuse it instead.
const CREDENTIAL_REUSE_MS = 10 * 60_000;
const CREDENTIAL_EXPIRY_MARGIN_MS = 5 * 60_000;

// The catalog the Codex client uses for cloud conversations, not the account's local one.
const CLOUD_MODELS_URL = "https://codex-cloud-backend.chatgpt.com/v2/models";
const CLOUD_MODEL_PAGES = 5;
/** Speeds the cloud accepts; Standard is sent as a cleared tier. */
const CLOUD_SERVICE_TIERS: ReadonlySet<string> = new Set([
  "default",
  "fast",
  "priority",
  "flex",
  "ultrafast",
]);
const decodeModelPage = Schema.decodeUnknownEffect(CodexSchema.V2ModelListResponse);

/** Each cloud turn carries a reasoning level and speed; the environment sets everything else. */
const cloudModelCapabilities = (capabilities: ServerProviderModel["capabilities"]) =>
  createModelCapabilities({
    optionDescriptors: (capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
      descriptor.id === "reasoningEffort"
        ? [descriptor]
        : descriptor.id === "serviceTier" && descriptor.type === "select"
          ? [
              {
                ...descriptor,
                options: descriptor.options.filter((option) => CLOUD_SERVICE_TIERS.has(option.id)),
              },
            ]
          : [],
    ),
  });

export const makeCodexCloudAccess = Effect.fn("CodexCloudAccess.make")(function* (input: {
  readonly sourceInstanceId: ProviderInstanceId;
  readonly config: CodexCloudSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly runner: CloudCliRunner;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environments = yield* CodexCloudEnvironments.CodexCloudEnvironments.pipe(
    Effect.provide(CodexCloudEnvironments.layer),
  );
  const serverConfig = yield* ServerConfig.ServerConfig;
  const managed =
    input.config.sourceSetupMode === "managed"
      ? yield* makeCodexChatGptAuth({
          instanceId: input.sourceInstanceId,
          defaultReturnUrl: `http://localhost:${serverConfig.port}/welcome`,
        })
      : undefined;
  const http = yield* HttpClient.HttpClient;
  const fetchCredentials = Effect.fn("CodexCloudAccess.fetchCredentials")(
    function* (cwd: string) {
      if (managed) {
        const credentials = yield* managed.controller.withAccess!(managed.access).pipe(
          Effect.scoped,
        );
        return {
          accessToken: credentials.accessToken,
          idToken: credentials.idToken,
          accountId: accountIdFromToken(credentials.accessToken),
        };
      }
      const { client } = yield* withCodexAppServerClient({
        binaryPath: input.config.binaryPath,
        homePath: input.config.homePath,
        launchArgs: input.config.launchArgs,
        cwd,
        environment: input.environment,
      });
      const auth = yield* client.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
      if (auth.authMethod !== "chatgpt" || !auth.authToken)
        return yield* new CloudCliError({
          detail: "Connect this Codex provider with ChatGPT before using Codex Cloud.",
        });
      return {
        accessToken: auth.authToken,
        idToken: undefined,
        accountId: accountIdFromToken(auth.authToken),
      };
    },
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () =>
        new CloudCliError({
          detail:
            "Could not use this provider's ChatGPT sign-in for Codex Cloud. Reconnect this account in provider settings.",
        }),
    ),
  );

  const cachedCredentials = yield* Ref.make<{
    readonly credentials: Effect.Success<ReturnType<typeof fetchCredentials>>;
    readonly reuseUntil: number;
  } | null>(null);
  const getCredentials = Effect.fn("CodexCloudAccess.getCredentials")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cachedCredentials);
    if (cached !== null && now < cached.reuseUntil) return cached.credentials;
    const credentials = yield* fetchCredentials(cwd);
    const expiresAt = tokenClaims(credentials.accessToken)?.exp;
    yield* Ref.set(cachedCredentials, {
      credentials,
      reuseUntil: Math.min(
        now + CREDENTIAL_REUSE_MS,
        expiresAt === undefined ? Infinity : expiresAt * 1000 - CREDENTIAL_EXPIRY_MARGIN_MS,
      ),
    });
    return credentials;
  });

  const run = Effect.fn("CodexCloudAccess.run")(
    function* (command: Parameters<CloudCliRunner["run"]>[0]) {
      if (
        !managed ||
        command.command !== input.config.binaryPath ||
        command.args[0] === "--version"
      )
        return yield* input.runner.run(command);
      const credentials = yield* getCredentials(command.cwd);
      if (command.args[0] === "login" && command.args[1] === "status")
        return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      if (!credentials.idToken)
        return yield* new CloudCliError({
          detail:
            "This ChatGPT connection has no Codex Cloud session token. Reconnect this account in provider settings.",
        });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cloud-" });
      yield* fs.writeFileString(
        path.join(directory, "auth.json"),
        yield* encodeCloudAuth({
          auth_mode: "chatgpt",
          tokens: {
            id_token: credentials.idToken,
            access_token: credentials.accessToken,
            refresh_token: null,
            account_id: credentials.accountId ?? null,
          },
        }),
        { mode: 0o600 },
      );
      const environment: NodeJS.ProcessEnv = { ...input.environment, CODEX_HOME: directory };
      delete environment.OPENAI_API_KEY;
      delete environment.OPENAI_BASE_URL;
      return yield* input.runner.run({
        ...command,
        args: ["-c", 'cli_auth_credentials_store="file"', ...command.args],
        environment,
      });
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isCloudCliError(cause)
        ? cause
        : new CloudCliError({
            detail: "Could not prepare the connected account for Codex Cloud.",
            cause,
          }),
    ),
  );

  const resolveEnvironment = Effect.fn("CodexCloudAccess.resolveEnvironment")(function* (
    cwd: string,
  ) {
    const origin = yield* input.runner.run({
      command: "git",
      args: ["remote", "get-url", "origin"],
      cwd,
    });
    const repository = parseGitRemoteRepository(origin.stdout.trim());
    if (origin.exitCode !== 0 || repository?.host !== "github.com")
      return yield* new CloudCliError({
        detail:
          "Codex Cloud needs this project's GitHub repository. Add a GitHub origin or configure an explicit cloud environment.",
      });
    const credentials = yield* getCredentials(cwd);
    return yield* environments.resolve({
      ...credentials,
      repository: repository.path.replace(/\.git$/u, ""),
    });
  });
  return {
    runner: { run, runInPty: input.runner.runInPty } satisfies CloudCliRunner,
    resolveEnvironment,
    nativeProtocol: Effect.fn("CodexCloudAccess.nativeProtocol")(function* (cwd: string) {
      const credentials = yield* getCredentials(cwd);
      if (!credentials.accountId)
        return yield* new CloudCliError({
          detail: "The connected ChatGPT account has no account ID.",
        });
      return makeCodexCloudProtocol({
        accessToken: credentials.accessToken,
        accountId: credentials.accountId,
      });
    }),
    models: Effect.fn("CodexCloudAccess.models")(
      function* () {
        const credentials = yield* getCredentials(process.cwd());
        if (!credentials.accountId) return [];
        const pages: Array<CodexSchema.V2ModelListResponse["data"]> = [];
        let cursor: string | null | undefined = null;
        for (let page = 0; page < CLOUD_MODEL_PAGES; page += 1) {
          const response: HttpClientResponse.HttpClientResponse = yield* http.execute(
            HttpClientRequest.get(CLOUD_MODELS_URL, {
              urlParams: { includeHidden: "false", limit: "100", ...(cursor ? { cursor } : {}) },
            }).pipe(
              HttpClientRequest.bearerToken(credentials.accessToken),
              HttpClientRequest.setHeader("chatgpt-account-id", credentials.accountId),
            ),
          );
          if (response.status < 200 || response.status >= 300)
            return yield* new CloudCliError({
              detail: `Codex Cloud returned HTTP ${response.status} for its model list.`,
            });
          const body: CodexSchema.V2ModelListResponse = yield* decodeModelPage(
            yield* response.json,
          );
          pages.push(body.data);
          cursor = body.nextCursor;
          if (!cursor) break;
        }
        return parseCodexModelListResponse({ data: pages.flat(), nextCursor: null }).map(
          (model) => ({
            ...model,
            capabilities: cloudModelCapabilities(model.capabilities),
          }),
        );
      },
      Effect.timeout("15 seconds"),
      Effect.mapError(
        (cause) =>
          new CloudCliError({ detail: "Could not read the Codex Cloud model list.", cause }),
      ),
    ),
  };
});
