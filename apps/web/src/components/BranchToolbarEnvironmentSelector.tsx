import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon } from "lucide-react";
import { memo } from "react";
import { T, useGT } from "gt-react";
import type {
  CloudMachineControls,
  CloudMachineTarget,
} from "@t3tools/client-runtime/provider-clients";

import { ADD_TO_MACHINE_LABEL_CLASS, type EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  cloudMachines?: CloudMachineControls | undefined;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const ADD_MACHINE_VALUE = "action:add-machine";

/** One line like the machine rows; an unusable target gives its reason on hover. */
export function CloudMachineRow({ target }: { readonly target: CloudMachineTarget }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <EnvironmentMachineIcon kind="cloud" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{target.label}</span>
      {target.disabledReason ? (
        <Tooltip>
          {/* The disabled row ignores the pointer; this label takes it back for the reason. */}
          <TooltipTrigger
            render={
              <span className="pointer-events-auto ms-auto shrink-0 ps-3 text-muted-foreground text-xs" />
            }
          >
            <T>Unavailable</T>
          </TooltipTrigger>
          <TooltipPopup side="top">{target.disabledReason}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  cloudMachines,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  const activeCloud = cloudMachines?.targets.find(
    (target) => target.instanceId === cloudMachines.selectedInstanceId,
  );

  const environmentItems = [
    ...(onAutoEnvironment
      ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? gt("Auto balance") }]
      : []),
    ...availableEnvironments.map((env) => ({
      value: environmentValue(env.environmentId),
      label: env.label,
    })),
    ...(cloudMachines?.targets.map((target) => ({
      value: `cloud:${target.instanceId}`,
      label: target.label,
    })) ?? []),
    ...(onAddToMachine ? [{ value: ADD_MACHINE_VALUE, label: gt("Add to another machine") }] : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (envLocked || (onEnvironmentChange === undefined && onAddToMachine === undefined)) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeCloud ? "cloud" : (activeEnvironment?.machine ?? "server")}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>
          {activeCloud?.label ?? activeEnvironment?.label ?? gt("Run on")}
        </ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {activeCloud?.label ?? activeEnvironment?.label ?? gt("Run on")}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={
        activeCloud
          ? `cloud:${activeCloud.instanceId}`
          : autoEnvironmentLabel
            ? AUTO_VALUE
            : environmentValue(environmentId)
      }
      onValueChange={(value) => {
        if (value === ADD_MACHINE_VALUE) {
          onAddToMachine?.();
        } else if (value === AUTO_VALUE) {
          cloudMachines?.onSelect(null);
          onAutoEnvironment?.();
        } else if (value?.startsWith("cloud:")) {
          const target = cloudMachines?.targets.find(
            (target) => `cloud:${target.instanceId}` === value,
          );
          if (target && !target.disabledReason) cloudMachines?.onSelect(target.instanceId);
        } else if (value?.startsWith("env:")) {
          cloudMachines?.onSelect(null);
          onEnvironmentChange?.(value.slice(4) as EnvironmentId);
        }
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label={gt("Run on")}
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeCloud ? "cloud" : (activeEnvironment?.machine ?? "server")}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {activeCloud?.label ?? autoEnvironmentLabel ?? activeEnvironment?.label ?? gt("Run on")}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>
            <T>Run on</T>
          </SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value={AUTO_VALUE}
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? gt("Auto balance")}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={onEnvironmentChange === undefined && env.environmentId !== environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {cloudMachines?.targets.map((target) => (
            <SelectItem
              key={target.instanceId}
              value={`cloud:${target.instanceId}`}
              disabled={target.disabledReason !== null}
            >
              <CloudMachineRow target={target} />
            </SelectItem>
          ))}
          {onAddToMachine ? (
            <SelectItem value={ADD_MACHINE_VALUE}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                <T>Add to another machine</T>
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
