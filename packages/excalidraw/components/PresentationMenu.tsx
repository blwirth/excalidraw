import { useState, useMemo, useEffect, useRef, useCallback } from "react";

import {
  actionAddPresentationStep,
  actionRemovePresentationStep,
  actionRenamePresentationStep,
  actionMovePresentationStep,
  actionAssignStepToGroup,
  actionSetActivePresentationStep,
  actionSetPresentationOpacities,
  actionAddSelectionToStep,
  actionRemoveSelectionFromStep,
  actionToggleSelectionAlwaysFull,
  actionClearSelectionStepTags,
  actionAddPresentationGroup,
  actionRemovePresentationGroup,
  actionRenamePresentationGroup,
  actionSetActivePresentationGroup,
  actionSetGroupOpacityMode,
} from "../actions";
import { useUIAppState } from "../context/ui-appState";
import {
  getRevealStepIds,
  getPresentationData,
} from "../presentation/computeStepOpacities";
import { exportPresentationStepsToFiles } from "../presentation/exportSteps";

import {
  useApp,
  useExcalidrawActionManager,
  useExcalidrawElements,
} from "./App";
import { TrashIcon } from "./icons";

import "./PresentationMenu.scss";

const UNASSIGNED_GROUP_VALUE = "__unassigned__";
const ALL_GROUPS_VALUE = "__all__";

export const PresentationMenu = () => {
  const appState = useUIAppState();
  const elements = useExcalidrawElements();
  const actionManager = useExcalidrawActionManager();
  const app = useApp();

  const presentation = appState.presentation;
  const allSteps = presentation.steps;
  const groups = presentation.groups ?? [];
  const activeGroupId = presentation.activeGroupId ?? null;
  const activeStepId = presentation.activeStepId;
  const globalPastOpacity = presentation.pastOpacity;
  const globalFutureOpacity = presentation.futureOpacity;

  // Opacity editor scope: when the diagram filter is set, edit that diagram's
  // overrides; otherwise edit the global defaults. Display shows the resolved
  // value (override ?? global) for the currently-filtered diagram.
  const opacityGroup = activeGroupId
    ? groups.find((g) => g.id === activeGroupId) ?? null
    : null;
  const opacityMode = opacityGroup?.opacityMode ?? "step-wise";
  const displayedPastOpacity = opacityGroup?.pastOpacity ?? globalPastOpacity;
  const displayedFutureOpacity =
    opacityGroup?.futureOpacity ?? globalFutureOpacity;

  // Always-full toggle scope: based on the active step's diagram (since that's
  // what's being previewed). Falls back to "unassigned" for steps without a group.
  const activeStep = allSteps.find((s) => s.id === activeStepId) ?? null;
  const alwaysFullScopeName = activeStep
    ? activeStep.groupId
      ? groups.find((g) => g.id === activeStep.groupId)?.name ?? "diagram"
      : "unassigned"
    : null;

  // Steps visible in the panel: filter by activeGroupId.
  // null activeGroupId means "all groups" (mixed view).
  const visibleSteps = useMemo(
    () =>
      activeGroupId === null
        ? allSteps
        : allSteps.filter((s) => (s.groupId ?? null) === activeGroupId),
    [allSteps, activeGroupId],
  );

  const selectedCount = Object.keys(appState.selectedElementIds).length;

  // Counts per step using multi-step membership (revealAtStepIds + legacy single).
  const stepCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let alwaysFull = 0;
    for (const el of elements) {
      if (el.isDeleted) {
        continue;
      }
      if (getPresentationData(el)?.alwaysFull) {
        alwaysFull += 1;
      }
      for (const id of getRevealStepIds(el)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return { perStep: counts, alwaysFull };
  }, [elements]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingGroup, setRenamingGroup] = useState(false);
  const [groupRenameDraft, setGroupRenameDraft] = useState("");
  const [exporting, setExporting] = useState(false);

  // ===========================================================================
  // Keyboard navigation: Up/Down cycles active step within the visible list,
  // but only when no canvas elements are selected (so element-nudging keeps
  // working) and no input is focused (so renaming text isn't hijacked).
  // ===========================================================================
  const setActiveStepRef = useRef<(stepId: string | null) => void>(() => {});
  setActiveStepRef.current = (stepId: string | null) =>
    actionManager.executeAction(
      actionSetActivePresentationStep,
      "ui",
      stepId,
    );
  const visibleStepsRef = useRef(visibleSteps);
  visibleStepsRef.current = visibleSteps;
  const activeStepIdRef = useRef(activeStepId);
  activeStepIdRef.current = activeStepId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      // Skip if user is typing in an input.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      // Skip if any canvas element is selected (let arrows nudge it).
      if (Object.keys(appState.selectedElementIds).length > 0) {
        return;
      }
      const steps = visibleStepsRef.current;
      if (steps.length === 0) {
        return;
      }
      const currentIdx = steps.findIndex(
        (s) => s.id === activeStepIdRef.current,
      );
      let nextIdx: number;
      if (currentIdx < 0) {
        nextIdx = e.key === "ArrowDown" ? 0 : steps.length - 1;
      } else {
        nextIdx =
          e.key === "ArrowDown"
            ? Math.min(steps.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1);
      }
      if (steps[nextIdx]?.id !== activeStepIdRef.current) {
        e.preventDefault();
        setActiveStepRef.current(steps[nextIdx].id);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [appState.selectedElementIds]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleAddStep = () =>
    actionManager.executeAction(actionAddPresentationStep);

  const handleSetActive = (stepId: string | null) =>
    actionManager.executeAction(
      actionSetActivePresentationStep,
      "ui",
      stepId,
    );

  const handleRemoveStep = (stepId: string) => {
    if (
      !confirm(
        "Delete this step? Elements in it will lose this step's reveal tag (other tags preserved).",
      )
    ) {
      return;
    }
    actionManager.executeAction(actionRemovePresentationStep, "ui", stepId);
  };

  const handleRenameCommit = (stepId: string) => {
    const name = renameDraft.trim();
    if (name) {
      actionManager.executeAction(actionRenamePresentationStep, "ui", {
        stepId,
        name,
      });
    }
    setRenamingId(null);
    setRenameDraft("");
  };

  const handleMove = (stepId: string, direction: "up" | "down") =>
    actionManager.executeAction(actionMovePresentationStep, "ui", {
      stepId,
      direction,
    });

  const handleStepGroupChange = (stepId: string, value: string) => {
    const groupId = value === UNASSIGNED_GROUP_VALUE ? null : value;
    actionManager.executeAction(actionAssignStepToGroup, "ui", {
      stepId,
      groupId,
    });
  };

  const handleAddToActiveStep = () => {
    if (!activeStepId) {
      return;
    }
    actionManager.executeAction(actionAddSelectionToStep, "ui", activeStepId);
  };

  const handleRemoveFromActiveStep = () => {
    if (!activeStepId) {
      return;
    }
    actionManager.executeAction(
      actionRemoveSelectionFromStep,
      "ui",
      activeStepId,
    );
  };

  const handleToggleAlwaysFull = () =>
    actionManager.executeAction(actionToggleSelectionAlwaysFull);

  const handleClearTags = () =>
    actionManager.executeAction(actionClearSelectionStepTags);

  const handleSetOpacity = (
    field: "pastOpacity" | "futureOpacity",
    value: number,
  ) => {
    if (Number.isNaN(value)) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, value));
    // If a diagram filter is active, write to that diagram's overrides.
    // Otherwise update the global defaults (also the fallback for diagrams
    // and the unassigned bucket).
    actionManager.executeAction(actionSetPresentationOpacities, "ui", {
      groupId: activeGroupId ?? null,
      [field]: clamped,
    });
  };

  const handleSetMode = (mode: "step-wise" | "highlight") => {
    if (!activeGroupId) {
      return;
    }
    actionManager.executeAction(actionSetGroupOpacityMode, "ui", {
      groupId: activeGroupId,
      mode,
    });
  };

  const handleResetGroupOpacity = (
    field: "pastOpacity" | "futureOpacity",
  ) => {
    if (!activeGroupId) {
      return;
    }
    actionManager.executeAction(actionSetPresentationOpacities, "ui", {
      groupId: activeGroupId,
      [field]: null,
    });
  };

  // Group handlers
  const handleGroupSelectorChange = (value: string) => {
    const groupId =
      value === ALL_GROUPS_VALUE
        ? null
        : value === UNASSIGNED_GROUP_VALUE
        ? null
        : value;
    // We treat both "all" and "unassigned" the same way internally
    // (activeGroupId = null shows all). Distinguish below if needed later.
    actionManager.executeAction(
      actionSetActivePresentationGroup,
      "ui",
      groupId,
    );
  };

  const handleAddGroup = () => {
    const name = prompt("Diagram name?");
    if (name === null) {
      return;
    }
    actionManager.executeAction(actionAddPresentationGroup, "ui", name);
  };

  const handleRemoveActiveGroup = () => {
    if (!activeGroupId) {
      return;
    }
    if (
      !confirm(
        "Delete this diagram? Its steps will become unassigned but their data is preserved.",
      )
    ) {
      return;
    }
    actionManager.executeAction(
      actionRemovePresentationGroup,
      "ui",
      activeGroupId,
    );
  };

  const handleGroupRenameCommit = useCallback(() => {
    if (!activeGroupId) {
      setRenamingGroup(false);
      return;
    }
    const name = groupRenameDraft.trim();
    if (name) {
      actionManager.executeAction(actionRenamePresentationGroup, "ui", {
        groupId: activeGroupId,
        name,
      });
    }
    setRenamingGroup(false);
    setGroupRenameDraft("");
  }, [actionManager, activeGroupId, groupRenameDraft]);

  const handleExport = async () => {
    if (allSteps.length === 0) {
      return;
    }
    setExporting(true);
    try {
      const count = await exportPresentationStepsToFiles({
        elements: elements.filter((el) => !el.isDeleted),
        appState,
        files: app.files,
        baseName: appState.name || "drawing",
      });
      if (count === 0) {
        alert(
          "Nothing was exported — no elements are tagged to steps in the selected diagram.",
        );
      }
    } catch (err) {
      console.error("Failed to export presentation steps", err);
      alert(`Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div className="presentation-menu">
      <div className="presentation-menu__group-bar">
        <label className="presentation-menu__group-label" htmlFor="pres-group">
          Diagram
        </label>
        <select
          id="pres-group"
          className="presentation-menu__group-select"
          value={activeGroupId ?? ALL_GROUPS_VALUE}
          onChange={(e) => handleGroupSelectorChange(e.target.value)}
        >
          <option value={ALL_GROUPS_VALUE}>All steps</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="presentation-menu__btn presentation-menu__btn--small"
          onClick={handleAddGroup}
          title="Add a new diagram group"
        >
          + Diagram
        </button>
        {activeGroup && (
          <>
            {renamingGroup ? (
              <input
                className="presentation-menu__rename-input"
                value={groupRenameDraft}
                autoFocus
                onChange={(e) => setGroupRenameDraft(e.target.value)}
                onBlur={handleGroupRenameCommit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleGroupRenameCommit();
                  } else if (e.key === "Escape") {
                    setRenamingGroup(false);
                    setGroupRenameDraft("");
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="presentation-menu__btn presentation-menu__btn--small"
                onClick={() => {
                  setGroupRenameDraft(activeGroup.name);
                  setRenamingGroup(true);
                }}
                title="Rename this diagram"
              >
                Rename
              </button>
            )}
            <button
              type="button"
              className="presentation-menu__btn presentation-menu__btn--small"
              onClick={handleRemoveActiveGroup}
              title="Delete this diagram (steps become unassigned)"
            >
              Delete
            </button>
          </>
        )}
      </div>

      <div className="presentation-menu__toolbar">
        <button
          type="button"
          className="presentation-menu__btn"
          onClick={handleAddStep}
        >
          + Add step
        </button>
        <button
          type="button"
          className="presentation-menu__btn"
          onClick={handleExport}
          disabled={visibleSteps.length === 0 || exporting}
          title={
            activeGroupId
              ? "Export steps in this diagram as SVGs"
              : "Export all steps as SVGs"
          }
        >
          {exporting ? "Exporting…" : "Export SVGs"}
        </button>
      </div>

      <div className="presentation-menu__steps">
        {visibleSteps.length === 0 && (
          <div className="presentation-menu__empty">
            {allSteps.length === 0
              ? 'No steps yet. Add a step, select elements on the canvas, then click "Add to active step."'
              : "No steps in this diagram. Click + Add step or switch the diagram filter."}
          </div>
        )}
        {visibleSteps.map((step, index) => {
          const isActive = activeStepId === step.id;
          const count = stepCounts.perStep.get(step.id) ?? 0;
          const stepGroupValue = step.groupId ?? UNASSIGNED_GROUP_VALUE;
          return (
            <div
              key={step.id}
              className={
                "presentation-menu__step" +
                (isActive ? " presentation-menu__step--active" : "")
              }
            >
              <div className="presentation-menu__step-row">
                <button
                  type="button"
                  className="presentation-menu__step-toggle"
                  onClick={() => handleSetActive(isActive ? null : step.id)}
                  title={isActive ? "Deactivate preview" : "Preview this step"}
                  aria-pressed={isActive}
                >
                  {isActive ? "●" : "○"}
                </button>
                <span className="presentation-menu__step-index">
                  {index + 1}.
                </span>
                {renamingId === step.id ? (
                  <input
                    className="presentation-menu__rename-input"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => handleRenameCommit(step.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleRenameCommit(step.id);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                        setRenameDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="presentation-menu__step-name"
                    onClick={() => {
                      setRenamingId(step.id);
                      setRenameDraft(step.name);
                    }}
                    title={`${step.name} — click to rename`}
                  >
                    {step.name}
                  </button>
                )}
                <span
                  className="presentation-menu__step-count"
                  title={`${count} element${count === 1 ? "" : "s"}`}
                >
                  {count}
                </span>
              </div>
              <div className="presentation-menu__step-row presentation-menu__step-row--secondary">
                {groups.length > 0 ? (
                  <select
                    className="presentation-menu__step-group"
                    value={stepGroupValue}
                    onChange={(e) =>
                      handleStepGroupChange(step.id, e.target.value)
                    }
                    title="Assign to diagram"
                  >
                    <option value={UNASSIGNED_GROUP_VALUE}>—</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="presentation-menu__step-group-spacer" />
                )}
                <span className="presentation-menu__step-actions">
                  <button
                    type="button"
                    onClick={() => handleMove(step.id, "up")}
                    disabled={index === 0}
                    title="Move up"
                    aria-label="Move step up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMove(step.id, "down")}
                    disabled={index === visibleSteps.length - 1}
                    title="Move down"
                    aria-label="Move step down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveStep(step.id)}
                    title="Delete step"
                    aria-label="Delete step"
                  >
                    {TrashIcon}
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="presentation-menu__section">
        <div className="presentation-menu__section-header">
          Selection ({selectedCount} element{selectedCount === 1 ? "" : "s"})
        </div>
        <div className="presentation-menu__selection-actions">
          <button
            type="button"
            className="presentation-menu__btn"
            onClick={handleAddToActiveStep}
            disabled={selectedCount === 0 || !activeStepId}
            title={
              !activeStepId
                ? "Activate a step first"
                : "Add selection to the active step (preserves other step memberships)"
            }
          >
            Add to active step
          </button>
          <button
            type="button"
            className="presentation-menu__btn"
            onClick={handleRemoveFromActiveStep}
            disabled={selectedCount === 0 || !activeStepId}
            title="Remove selection from the active step (other memberships preserved)"
          >
            Remove from active step
          </button>
          <button
            type="button"
            className="presentation-menu__btn"
            onClick={handleToggleAlwaysFull}
            disabled={selectedCount === 0 || !activeStep}
            title={
              !activeStep
                ? "Activate a step first"
                : `Pin/unpin selection to full opacity in “${alwaysFullScopeName}” (this diagram only)`
            }
          >
            {alwaysFullScopeName
              ? `Toggle always-full in ${alwaysFullScopeName}`
              : "Toggle always-full"}
          </button>
          <button
            type="button"
            className="presentation-menu__btn"
            onClick={handleClearTags}
            disabled={selectedCount === 0}
            title="Wipe all step memberships and pins from selection"
          >
            Clear all tags
          </button>
        </div>
        <div className="presentation-menu__hint">
          Always-full elements: {stepCounts.alwaysFull}. Tip: ↑/↓ steps through
          when nothing is selected on the canvas.
        </div>
      </div>

      <div className="presentation-menu__section">
        <div className="presentation-menu__section-header">
          Opacity
          {opacityGroup ? (
            <span className="presentation-menu__hint">
              {" "}
              for {opacityGroup.name}
            </span>
          ) : (
            <span className="presentation-menu__hint"> (global default)</span>
          )}
        </div>
        {opacityGroup && (
          <div className="presentation-menu__opacity-row">
            <span>Mode</span>
            <span className="presentation-menu__opacity-controls">
              <select
                className="presentation-menu__group-select"
                value={opacityMode}
                onChange={(e) =>
                  handleSetMode(
                    e.target.value as "step-wise" | "highlight",
                  )
                }
                title="Step-wise: past/current/future. Highlight: only the active step is full opacity, everything else is faded."
              >
                <option value="step-wise">Step-wise (past · current · future)</option>
                <option value="highlight">Highlight (current vs faded)</option>
              </select>
            </span>
          </div>
        )}
        {opacityMode === "step-wise" && (
          <label className="presentation-menu__opacity-row">
            Past
          <span className="presentation-menu__opacity-controls">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={displayedPastOpacity}
              onChange={(e) =>
                handleSetOpacity("pastOpacity", parseFloat(e.target.value))
              }
            />
              {opacityGroup && opacityGroup.pastOpacity !== undefined && (
                <button
                  type="button"
                  className="presentation-menu__btn presentation-menu__btn--small"
                  onClick={() => handleResetGroupOpacity("pastOpacity")}
                  title={`Reset to global default (${globalPastOpacity})`}
                >
                  Reset
                </button>
              )}
            </span>
          </label>
        )}
        <label className="presentation-menu__opacity-row">
          {opacityMode === "highlight" ? "Faded" : "Future"}
          <span className="presentation-menu__opacity-controls">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={displayedFutureOpacity}
              onChange={(e) =>
                handleSetOpacity("futureOpacity", parseFloat(e.target.value))
              }
            />
            {opacityGroup && opacityGroup.futureOpacity !== undefined && (
              <button
                type="button"
                className="presentation-menu__btn presentation-menu__btn--small"
                onClick={() => handleResetGroupOpacity("futureOpacity")}
                title={`Reset to global default (${globalFutureOpacity})`}
              >
                Reset
              </button>
            )}
          </span>
        </label>
      </div>
    </div>
  );
};
