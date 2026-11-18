import {
  AntigravitySettings,
  ClaudeSettings,
  ClaudeCloudSettings,
  CodexSettings,
  CodexCloudSettings,
  isProviderDriverKind,
  ProviderDriverKind,
  cloudSourceInstanceId,
  type ServerProvider,
  type ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry, type ProviderIcon } from "@t3tools/provider-core/client";
import { modelShortName } from "@t3tools/provider-core/modelShortName";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

export interface CloudMachineTarget {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly disabledReason: string | null;
}

export interface CloudMachineControls {
  readonly targets: ReadonlyArray<CloudMachineTarget>;
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly onSelect: (instanceId: ProviderInstanceId | null) => void;
}

const CLOUD_BRAND_DRIVER: Readonly<Record<string, ProviderDriverKind>> = {
  claudeCloud: ProviderDriverKind.make("claudeAgent"),
  codexCloud: ProviderDriverKind.make("codex"),
};

/** Cloud drivers wear the logo of the agent they run remotely. */
export function providerBrandDriverKind<Driver extends string>(
  driver: Driver,
): Driver | ProviderDriverKind {
  return CLOUD_BRAND_DRIVER[driver] ?? driver;
}

const isCloudDriver = (driver: string) => driver === "claudeCloud" || driver === "codexCloud";

/**
 * A cloud host runs only its own provider, so its picker lists nothing else; on a machine, cloud
 * instances stay out of the list because "Run on" picks them.
 */
export function modelPickerInstancesForHost<Entry>(
  entries: ReadonlyArray<Entry>,
  activeInstanceId: string | null | undefined,
  identify: (entry: Entry) => { readonly instanceId: string; readonly driver: string },
): ReadonlyArray<Entry> {
  const activeCloud = entries.find((entry) => {
    const { instanceId, driver } = identify(entry);
    return instanceId === activeInstanceId && isCloudDriver(driver);
  });
  return entries.filter((entry) =>
    activeCloud === undefined ? !isCloudDriver(identify(entry).driver) : entry === activeCloud,
  );
}

/** Moving between a machine and a cloud keeps the model when the new host offers it. */
export function cloudMachineModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  current: Pick<ModelSelection, "instanceId" | "model"> | null,
  target: ProviderInstanceId | null,
): ModelSelection | null {
  const targets = cloudMachineTargets(providers);
  const sameOrDefault = (provider: ServerProvider | undefined): ModelSelection | null => {
    const model =
      provider?.models.find((model) => model.slug === current?.model) ??
      provider?.models.find((model) => model.isDefault) ??
      provider?.models[0];
    return provider && model ? { instanceId: provider.instanceId, model: model.slug } : null;
  };
  if (target !== null) {
    const cloud = targets.find((candidate) => candidate.instanceId === target);
    return cloud && cloud.disabledReason === null
      ? sameOrDefault(providers.find((provider) => provider.instanceId === target))
      : null;
  }
  const currentId = current?.instanceId ?? null;
  if (!targets.some((candidate) => candidate.instanceId === currentId)) return null;
  const sourceId =
    currentId === null
      ? null
      : cloudSourceInstanceId(
          currentId,
          providers.map((provider) => provider.instanceId),
        );
  const sources = providers.filter(
    (provider) =>
      provider.driver !== "codexCloud" &&
      provider.driver !== "claudeCloud" &&
      provider.enabled &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      provider.status !== "error",
  );
  return sameOrDefault(sources.find((provider) => provider.instanceId === sourceId) ?? sources[0]);
}

export function cloudMachineTargets(
  providers: ReadonlyArray<ServerProvider>,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<CloudMachineTarget> {
  return providers.flatMap((provider) => {
    if (provider.driver !== "codexCloud" && provider.driver !== "claudeCloud") return [];
    const sourceId = cloudSourceInstanceId(
      provider.instanceId,
      providers.map((provider) => provider.instanceId),
    );
    const source =
      sourceId === null ? null : providers.find((candidate) => candidate.instanceId === sourceId);
    if (!provider.enabled || (source && !source.enabled)) return [];
    return [
      {
        instanceId: provider.instanceId,
        label:
          provider.displayName ??
          // oxlint-disable-next-line t3code/no-untranslated-copy -- product names stay English
          (provider.driver === "codexCloud" ? "Codex Cloud" : "Claude Cloud"),
        disabledReason:
          !provider.installed ||
          provider.status !== "ready" ||
          provider.auth.status !== "authenticated"
            ? (provider.message ??
              resolve(
                msg(
                  "Connect this provider account in Settings before using its cloud environment.",
                ),
              ))
            : null,
      },
    ];
  });
}

// OpenRouter's Ink and Cloud glyphs from https://openrouter.ai/brand.
export const openRouterIcon: ProviderIcon = {
  viewBox: "0 0 1024 730",
  fill: { light: "#03080A", dark: "#FCFCFE" },
  paths: [
    {
      d: "M795.893 0C915.776 0 1012.95 97.9963 1012.95 218.88C1012.95 339.764 915.776 437.76 795.893 437.76L1011.2 654.869C1038.55 682.447 1019.18 729.6 980.504 729.6H361.77C161.97 729.6 0 566.273 0 364.8C0 163.327 161.97 0 361.77 0L795.893 0ZM361.77 145.92C241.89 145.92 144.708 243.916 144.708 364.8C144.708 485.684 241.89 583.68 361.77 583.68C481.649 583.68 578.831 485.684 578.831 364.8C578.831 243.916 481.649 145.92 361.77 145.92Z",
    },
  ],
};

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("codexCloud"),
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name stays English
    label: "Codex Cloud",
    modelFamilies: [],
    settingsSchema: CodexCloudSettings,
    featured: false,
  },
  {
    driverKind: ProviderDriverKind.make("claudeCloud"),
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name stays English
    label: "Claude Cloud",
    modelFamilies: [],
    settingsSchema: ClaudeCloudSettings,
    featured: false,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  kiroClient,
  museClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
