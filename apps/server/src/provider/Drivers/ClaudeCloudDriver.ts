import {
  ClaudeCloudSettings,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  cloudCliAuthenticated,
  makeSpawnCloudCliRunner,
  type CloudCliRunner,
} from "../CloudCli.ts";
import { createCloudAdapterV2 } from "../../orchestration-v2/Adapters/CloudAdapterV2.ts";
import { makeClaudeCloudSessions } from "../ClaudeCloudSessions.ts";
import {
  CLAUDE_EFFORT_LEVELS,
  type ClaudeModelCatalog,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
} from "../ClaudeModelCatalog.ts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

const DRIVER_KIND = ProviderDriverKind.make("claudeCloud");
const decodeClaudeCloudSettings = Schema.decodeSync(ClaudeCloudSettings);

export type ClaudeCloudDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ModelCatalog.ModelCatalog
  | Effect.Services<ReturnType<typeof makeClaudeCloudSessions>>;

const CLI_EFFORT_LEVELS: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS);

/**
 * A cloud session takes only effort (`--effort`, then `apply_flag_settings`) and Ultracode
 * (`apply_flag_settings`); the CLI refuses every other setting over Remote Control.
 */
const claudeCloudCapabilities = (capabilities: ServerProviderModel["capabilities"]) =>
  createModelCapabilities({
    optionDescriptors: (capabilities?.optionDescriptors ?? []).flatMap(
      (descriptor): ReadonlyArray<ProviderOptionDescriptor> =>
        descriptor.id === "effort" && descriptor.type === "select"
          ? [
              {
                ...descriptor,
                options: descriptor.options.filter((option) => CLI_EFFORT_LEVELS.has(option.id)),
              },
            ]
          : descriptor.id === "ultracode" && descriptor.type === "boolean"
            ? [descriptor]
            : [],
    ),
  });

/** The local CLI creates the session, so its version gates the models as for local Claude. */
const claudeCloudModels = (
  catalog: ClaudeModelCatalog,
  version: string | null,
): ReadonlyArray<ServerProviderModel> =>
  (version === null
    ? catalog.models.map((entry) => entry.model)
    : resolveClaudeModelsForVersion(catalog, version)
  ).map((model) => ({ ...model, capabilities: claudeCloudCapabilities(model.capabilities) }));

const unsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Claude Cloud instances do not provide application text generation.",
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

const probeClaudeCloud = Effect.fn("ClaudeCloudDriver.probe")(function* (
  runner: CloudCliRunner,
  config: ClaudeCloudSettings,
  environment: NodeJS.ProcessEnv,
  catalog: ClaudeModelCatalog,
  platform: NodeJS.Platform,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!config.enabled) {
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "Claude Cloud" },
      enabled: false,
      checkedAt,
      models: claudeCloudModels(catalog, null),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Cloud is disabled in T3 Code settings.",
      },
    }) satisfies ServerProviderDraft;
  }
  // Creating a session runs the CLI under `script` for a terminal, and Windows has no `script`.
  if (platform === "win32") {
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "Claude Cloud" },
      enabled: true,
      checkedAt,
      models: claudeCloudModels(catalog, null),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Cloud is not available on Windows yet.",
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
      presentation: { displayName: "Claude Cloud" },
      enabled: true,
      checkedAt,
      models: claudeCloudModels(catalog, null),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "The claude CLI could not be started. Check its binary path in settings.",
      },
    }) satisfies ServerProviderDraft;
  }
  const login = yield* runner
    .run({ command: config.binaryPath, args: ["auth", "status"], cwd: process.cwd(), environment })
    .pipe(Effect.option);
  const authenticated = Option.isSome(login) && cloudCliAuthenticated("claude", login.value);
  const cliVersion = /^(\d+\.\S+)/u.exec(version.value.stdout.trim())?.[1] ?? null;
  return buildServerProvider({
    driver: DRIVER_KIND,
    presentation: { displayName: "Claude Cloud" },
    enabled: true,
    checkedAt,
    models: claudeCloudModels(catalog, cliVersion),
    probe: {
      installed: true,
      version: cliVersion,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unauthenticated" },
      ...(!authenticated
        ? {
            message:
              "Sign in to this Claude Code account with a Claude subscription to use cloud sessions.",
          }
        : {}),
    },
  }) satisfies ServerProviderDraft;
});

export const ClaudeCloudDriver: ProviderDriver<ClaudeCloudSettings, ClaudeCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: ClaudeCloudSettings,
  defaultConfig: (): ClaudeCloudSettings => decodeClaudeCloudSettings({}),
  create: Effect.fn("ClaudeCloudDriver.create")(function* ({
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
    const platform = yield* HostProcess.Platform;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const path = yield* Path.Path;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      hostEnvironment,
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, homeDirectory),
    } satisfies ClaudeCloudSettings;
    if (config.homePath?.trim())
      processEnvironment.CLAUDE_CONFIG_DIR = expandHomePath(config.homePath, homeDirectory);
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(ProviderDriverKind.make("claudeAgent"))
      .pipe(Effect.map(resolveClaudeModelCatalog));
    const runner = yield* makeSpawnCloudCliRunner().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
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
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<ClaudeCloudSettings>
    >({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            probeClaudeCloud(runner, settings.provider, processEnvironment, catalog, platform),
          ),
          Effect.map(stampIdentity),
        ),
      checkProvider: catalogService.refreshInBackground.pipe(
        Effect.andThen(modelCatalog),
        Effect.flatMap((catalog) =>
          probeClaudeCloud(runner, effectiveConfig, processEnvironment, catalog, platform),
        ),
        Effect.map(stampIdentity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Claude Cloud snapshot.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter = yield* createCloudAdapterV2({
      instanceId,
      driver: DRIVER_KIND,
      flavor: "claude",
      config: { binaryPath: effectiveConfig.binaryPath },
      runner,
      environment: processEnvironment,
      claudeSessions: yield* makeClaudeCloudSessions({
        configDir: processEnvironment.CLAUDE_CONFIG_DIR || path.join(homeDirectory, ".claude"),
      }),
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
