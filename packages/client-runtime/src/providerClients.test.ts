import { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  cloudMachineModelSelection,
  cloudMachineTargets,
  modelPickerInstancesForHost,
} from "./providerClients.ts";

const decodeProvider = Schema.decodeSync(ServerProvider);

it("routes cloud choices to their account, keeping the model wherever the new host offers it", () => {
  const model = (slug: string, isDefault = false) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    isDefault,
  });
  const local = decodeProvider({
    instanceId: "work",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-09T00:00:00Z",
    models: [model("local-default", true), model("shared")],
  });
  const cloud = decodeProvider({
    ...local,
    instanceId: "cloud_work",
    driver: "codexCloud",
    displayName: "Codex Cloud · Work",
    models: [model("cloud-default", true), model("shared")],
  });
  const pick = (current: { instanceId: string; model: string }, target: string | null) =>
    cloudMachineModelSelection(
      [local, cloud],
      { instanceId: ProviderInstanceId.make(current.instanceId), model: current.model },
      target === null ? null : ProviderInstanceId.make(target),
    );
  expect(pick({ instanceId: "work", model: "shared" }, "cloud_work")).toEqual({
    instanceId: cloud.instanceId,
    model: "shared",
  });
  expect(pick({ instanceId: "work", model: "local-default" }, "cloud_work")?.model).toBe(
    "cloud-default",
  );
  expect(pick({ instanceId: "cloud_work", model: "shared" }, null)).toEqual({
    instanceId: local.instanceId,
    model: "shared",
  });
  expect(pick({ instanceId: "cloud_work", model: "cloud-default" }, null)?.model).toBe(
    "local-default",
  );
  expect(
    cloudMachineModelSelection([local, cloud], null, ProviderInstanceId.make("missing")),
  ).toBeNull();
  const signedOut = {
    ...cloud,
    auth: { status: "unauthenticated" as const },
    message: "Sign in to Work",
  };
  expect(cloudMachineTargets([local, signedOut])[0]?.disabledReason).toBe("Sign in to Work");
  expect(cloudMachineModelSelection([local, signedOut], null, cloud.instanceId)).toBeNull();
  expect(cloudMachineTargets([{ ...local, enabled: false }, cloud])).toEqual([]);
});

it("lists only the chosen cloud on a cloud host and keeps clouds out on a machine", () => {
  const entries = [
    { instanceId: "codex", driver: "codex" },
    { instanceId: "claudeAgent", driver: "claudeAgent" },
    { instanceId: "cloud_claudeAgent", driver: "claudeCloud" },
    { instanceId: "cloud_codex", driver: "codexCloud" },
  ];
  const visible = (active: string | null) =>
    modelPickerInstancesForHost(entries, active, (entry) => entry).map((entry) => entry.instanceId);
  expect(visible("cloud_claudeAgent")).toEqual(["cloud_claudeAgent"]);
  expect(visible("claudeAgent")).toEqual(["codex", "claudeAgent"]);
  expect(visible(null)).toEqual(["codex", "claudeAgent"]);
});
