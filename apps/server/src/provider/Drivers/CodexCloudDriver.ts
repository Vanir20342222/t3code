import {
  CodexCloudSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  buildServerProvider,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Option from "effect/Option";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  cloudCliAuthenticated,
  CloudCliError,
  makeSpawnCloudCliRunner,
  type CloudCliRunner,
} from "../CloudCli.ts";
import { createCloudAdapterV2 } from "../../orchestration-v2/Adapters/CloudAdapterV2.ts";
import { makeCodexCloudAccess } from "../CodexCloudAccess.ts";
import { cloudNativeModel } from "../CodexCloudProtocol.ts";
import { makeCodexCloudWarmThread } from "../CodexCloudWarmThread.ts";
import * as CodexInstallation from "../CodexInstallation.ts";

const DRIVER_KIND = ProviderDriverKind.make("codexCloud");
const decodeCodexCloudSettings = Schema.decodeSync(CodexCloudSettings);

export type CodexCloudDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Effect.Services<ReturnType<typeof makeCodexCloudAccess>>
  | CodexInstallation.CodexInstallation;

const CODEX_CLOUD_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Default cloud model",
    isCustom: false,
    isDefault: true,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

const unsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Codex Cloud instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
};

const probeCodexCloud = Effect.fn("CodexCloudDriver.probe")(function* (
  runner: CloudCliRunner,
  config: CodexCloudSettings,
  environment: NodeJS.ProcessEnv,
  loadModels: () => Effect.Effect<ReadonlyArray<ServerProviderModel>, { readonly message: string }>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!config.enabled) {
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "Codex Cloud" },
      enabled: config.enabled,
      checkedAt,
      models: CODEX_CLOUD_MODELS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex Cloud is disabled in T3 Code settings.",
      },
    }) satisfies ServerProviderDraft;
  }
  const version = yield* runner
    .run({
      command: config.binaryPath,
      args: ["--version"],
      cwd: process.cwd(),
      environment,
    })
    .pipe(Effect.option);
  if (Option.isNone(version) || version.value.exitCode !== 0) {
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "Codex Cloud" },
      enabled: true,
      checkedAt,
      models: CODEX_CLOUD_MODELS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "The codex CLI could not be started. Check its binary path in settings.",
      },
    }) satisfies ServerProviderDraft;
  }
  const login = yield* runner
    .run({ command: config.binaryPath, args: ["login", "status"], cwd: process.cwd(), environment })
    .pipe(Effect.option);
  const authenticated = Option.isSome(login) && cloudCliAuthenticated("codex", login.value);
  const catalog = authenticated ? yield* loadModels().pipe(Effect.option) : Option.none();
  const message = !authenticated
    ? "Sign in to this Codex provider with ChatGPT to use Codex Cloud."
    : undefined;
  return buildServerProvider({
    driver: DRIVER_KIND,
    presentation: { displayName: "Codex Cloud" },
    enabled: true,
    checkedAt,
    models: Option.isSome(catalog) && catalog.value.length ? catalog.value : CODEX_CLOUD_MODELS,
    probe: {
      installed: true,
      version: /^codex-cli (\S+)/u.exec(version.value.stdout.trim())?.[1] ?? null,
      status: message ? "warning" : "ready",
      auth: { status: authenticated ? "authenticated" : "unauthenticated" },
      ...(message ? { message } : {}),
    },
  }) satisfies ServerProviderDraft;
});

export const CodexCloudDriver: ProviderDriver<CodexCloudSettings, CodexCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: CodexCloudSettings,
  defaultConfig: (): CodexCloudSettings => decodeCodexCloudSettings({}),
  create: Effect.fn("CodexCloudDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    yield* ProviderHost.ProviderHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcess.Environment;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      hostEnvironment,
    );
    const managedExecutable =
      config.sourceSetupMode === "managed"
        ? yield* (yield* CodexInstallation.CodexInstallation).resolve().pipe(Effect.option)
        : Option.none();
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: Option.isSome(managedExecutable)
        ? managedExecutable.value.executablePath
        : expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies CodexCloudSettings;
    if (config.homePath?.trim())
      processEnvironment.CODEX_HOME = expandHomePath(
        config.homePath,
        yield* HostProcess.HomeDirectory,
      );
    const nativeRunner = yield* makeSpawnCloudCliRunner().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cloudAccess = yield* makeCodexCloudAccess({
      sourceInstanceId: config.sourceInstanceId ?? instanceId,
      config: effectiveConfig,
      environment: processEnvironment,
      runner: nativeRunner,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not prepare Codex Cloud account access.",
            cause,
          }),
      ),
    );
    const runner = cloudAccess.runner;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const maintenance: ProviderMaintenanceCapabilities =
      makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null });
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexCloudSettings>>(
      {
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          probeCodexCloud(runner, settings.provider, processEnvironment, cloudAccess.models).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider: probeCodexCloud(
          runner,
          effectiveConfig,
          processEnvironment,
          cloudAccess.models,
        ).pipe(Effect.map(stampIdentity)),
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Codex Cloud snapshot.",
            cause,
          }),
      ),
    );
    const configuredEnvironment = effectiveConfig.environment.trim() || undefined;
    const environmentFor = (cwd: string) =>
      configuredEnvironment === undefined
        ? cloudAccess.resolveEnvironment(cwd)
        : Effect.succeed(configuredEnvironment);
    const warmThread = yield* makeCodexCloudWarmThread((model, environment) =>
      cloudAccess.nativeProtocol(process.cwd()).pipe(
        Effect.flatMap((protocol) =>
          Effect.tryPromise({
            try: () => protocol.prewarm(cloudNativeModel(model), environment),
            catch: (cause) =>
              new CloudCliError({
                detail: cause instanceof Error ? cause.message : "Codex Cloud warm-up failed.",
                cause,
              }),
          }),
        ),
      ),
    );
    const orchestrationAdapter = yield* createCloudAdapterV2({
      instanceId,
      driver: DRIVER_KIND,
      flavor: "codex",
      config: {
        binaryPath: effectiveConfig.binaryPath,
        environment: configuredEnvironment,
      },
      runner,
      resolveEnvironment: environmentFor,
      nativeProtocol: cloudAccess.nativeProtocol,
      warmThread,
      environment: processEnvironment,
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      warmUp: ({ model, cwd }) =>
        cwd === undefined
          ? Effect.void
          : environmentFor(cwd).pipe(
              Effect.flatMap((environment) => warmThread.warm(model, environment)),
              Effect.catch((error) =>
                Effect.logWarning("Codex Cloud warm-up skipped", error.message),
              ),
            ),
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
