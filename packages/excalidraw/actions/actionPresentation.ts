import { randomId } from "@excalidraw/common";

import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { register } from "./register";

import type { AppState } from "../types";
import type { PresentationCustomData } from "../presentation/computeStepOpacities";
import {
  getRevealStepIds,
  groupKeyOf,
} from "../presentation/computeStepOpacities";

const presentationOf = (
  el: ExcalidrawElement,
): PresentationCustomData | null => {
  const raw = el.customData?.presentation;
  return raw && typeof raw === "object" ? (raw as PresentationCustomData) : null;
};

const withPresentation = (
  el: ExcalidrawElement,
  patch: PresentationCustomData | null,
): ExcalidrawElement => {
  const nextCustom = { ...(el.customData ?? {}) };
  if (patch == null) {
    delete nextCustom.presentation;
  } else {
    // Always strip the legacy single-id field — `revealAtStepIds` is the
    // canonical storage going forward.
    const { revealAtStepId: _legacy, ...clean } = patch;
    nextCustom.presentation = clean;
  }
  const hasAny = Object.keys(nextCustom).length > 0;
  return newElementWith(el, { customData: hasAny ? nextCustom : undefined });
};

/** Returns the set of selected element ids, expanded to include bound text + frame children. */
const getSelectedIdsForPresentation = (
  appState: Readonly<AppState>,
  app: { scene: { getSelectedElements: (opts: any) => ExcalidrawElement[] } },
): Set<string> => {
  const selected = app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
    includeBoundTextElement: true,
    includeElementsInFrames: true,
  });
  return new Set(selected.map((e) => e.id));
};

// =============================================================================
// Steps
// =============================================================================

export const actionAddPresentationStep = register({
  name: "addPresentationStep",
  label: "labels.presentation.addStep",
  trackEvent: { category: "presentation" },
  perform: (elements, appState) => {
    const id = randomId();
    const groupId = appState.presentation.activeGroupId ?? null;
    const stepsInGroup = appState.presentation.steps.filter(
      (s) => (s.groupId ?? null) === groupId,
    );
    const nextSteps = [
      ...appState.presentation.steps,
      { id, name: `Step ${stepsInGroup.length + 1}`, groupId },
    ];
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          steps: nextSteps,
          activeStepId: id,
        },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionRemovePresentationStep = register<string>({
  name: "removePresentationStep",
  label: "labels.presentation.removeStep",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, stepId: string | undefined) => {
    if (!stepId) {
      return false;
    }
    const nextSteps = appState.presentation.steps.filter(
      (s) => s.id !== stepId,
    );
    const nextElements = elements.map((el) => {
      const ids = getRevealStepIds(el);
      if (!ids.has(stepId)) {
        return el;
      }
      ids.delete(stepId);
      const data = presentationOf(el) ?? {};
      const remaining = Array.from(ids);
      if (remaining.length === 0 && !data.alwaysFull) {
        return withPresentation(el, null);
      }
      return withPresentation(el, {
        ...data,
        revealAtStepIds: remaining,
      });
    });
    const nextActive =
      appState.presentation.activeStepId === stepId
        ? null
        : appState.presentation.activeStepId;
    return {
      elements: nextElements,
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          steps: nextSteps,
          activeStepId: nextActive,
        },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionRenamePresentationStep = register<{
  stepId: string;
  name: string;
}>({
  name: "renamePresentationStep",
  label: "labels.presentation.renameStep",
  trackEvent: { category: "presentation" },
  perform: (
    elements,
    appState,
    formData: { stepId: string; name: string } | undefined,
  ) => {
    if (!formData) {
      return false;
    }
    const nextSteps = appState.presentation.steps.map((s) =>
      s.id === formData.stepId ? { ...s, name: formData.name } : s,
    );
    return {
      appState: {
        ...appState,
        presentation: { ...appState.presentation, steps: nextSteps },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

export const actionMovePresentationStep = register<{
  stepId: string;
  direction: "up" | "down";
}>({
  name: "movePresentationStep",
  label: "labels.presentation.moveStep",
  trackEvent: { category: "presentation" },
  perform: (
    elements,
    appState,
    formData: { stepId: string; direction: "up" | "down" } | undefined,
  ) => {
    if (!formData) {
      return false;
    }
    const steps = [...appState.presentation.steps];
    const currentStep = steps.find((s) => s.id === formData.stepId);
    if (!currentStep) {
      return false;
    }
    const groupId = currentStep.groupId ?? null;
    // Reorder only within the same group: find prev/next sibling in group.
    const siblingIndices = steps
      .map((s, i) => ((s.groupId ?? null) === groupId ? i : -1))
      .filter((i) => i >= 0);
    const positionInGroup = siblingIndices.indexOf(
      steps.findIndex((s) => s.id === formData.stepId),
    );
    const swapPosInGroup =
      formData.direction === "up" ? positionInGroup - 1 : positionInGroup + 1;
    if (swapPosInGroup < 0 || swapPosInGroup >= siblingIndices.length) {
      return false;
    }
    const a = siblingIndices[positionInGroup];
    const b = siblingIndices[swapPosInGroup];
    [steps[a], steps[b]] = [steps[b], steps[a]];
    return {
      appState: {
        ...appState,
        presentation: { ...appState.presentation, steps },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionAssignStepToGroup = register<{
  stepId: string;
  groupId: string | null;
}>({
  name: "assignPresentationStepToGroup",
  label: "labels.presentation.assignStepToGroup",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, formData) => {
    if (!formData) {
      return false;
    }
    const nextSteps = appState.presentation.steps.map((s) =>
      s.id === formData.stepId ? { ...s, groupId: formData.groupId } : s,
    );
    return {
      appState: {
        ...appState,
        presentation: { ...appState.presentation, steps: nextSteps },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionSetActivePresentationStep = register<string | null>({
  name: "setActivePresentationStep",
  label: "labels.presentation.setActiveStep",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, stepId: string | null | undefined) => {
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          activeStepId: stepId === undefined ? null : stepId,
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

export const actionSetPresentationOpacities = register<{
  /** When set, writes to this diagram's overrides; otherwise edits the global defaults. */
  groupId?: string | null;
  /** Number to set, or `null` to clear the per-diagram override. */
  pastOpacity?: number | null;
  futureOpacity?: number | null;
}>({
  name: "setPresentationOpacities",
  label: "labels.presentation.setOpacities",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, formData) => {
    if (!formData) {
      return false;
    }
    const { groupId, pastOpacity, futureOpacity } = formData;
    if (groupId) {
      const groups = (appState.presentation.groups ?? []).map((g) => {
        if (g.id !== groupId) {
          return g;
        }
        const next: typeof g = { ...g };
        if (pastOpacity === null) {
          delete next.pastOpacity;
        } else if (pastOpacity !== undefined) {
          next.pastOpacity = pastOpacity;
        }
        if (futureOpacity === null) {
          delete next.futureOpacity;
        } else if (futureOpacity !== undefined) {
          next.futureOpacity = futureOpacity;
        }
        return next;
      });
      return {
        appState: {
          ...appState,
          presentation: { ...appState.presentation, groups },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          ...(typeof pastOpacity === "number" && { pastOpacity }),
          ...(typeof futureOpacity === "number" && { futureOpacity }),
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

// =============================================================================
// Groups (diagrams)
// =============================================================================

export const actionAddPresentationGroup = register<string | undefined>({
  name: "addPresentationGroup",
  label: "labels.presentation.addGroup",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, name: string | undefined) => {
    const id = randomId();
    const groups = appState.presentation.groups ?? [];
    const nextGroups = [
      ...groups,
      { id, name: name?.trim() || `Diagram ${groups.length + 1}` },
    ];
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          groups: nextGroups,
          activeGroupId: id,
        },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionRemovePresentationGroup = register<string>({
  name: "removePresentationGroup",
  label: "labels.presentation.removeGroup",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, groupId: string | undefined) => {
    if (!groupId) {
      return false;
    }
    const groups = (appState.presentation.groups ?? []).filter(
      (g) => g.id !== groupId,
    );
    // Steps in the deleted group revert to "unassigned" (groupId: null) so
    // their data is preserved.
    const nextSteps = appState.presentation.steps.map((s) =>
      (s.groupId ?? null) === groupId ? { ...s, groupId: null } : s,
    );
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          groups,
          steps: nextSteps,
          activeGroupId:
            appState.presentation.activeGroupId === groupId
              ? null
              : appState.presentation.activeGroupId,
        },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionRenamePresentationGroup = register<{
  groupId: string;
  name: string;
}>({
  name: "renamePresentationGroup",
  label: "labels.presentation.renameGroup",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, formData) => {
    if (!formData) {
      return false;
    }
    const groups = (appState.presentation.groups ?? []).map((g) =>
      g.id === formData.groupId ? { ...g, name: formData.name } : g,
    );
    return {
      appState: {
        ...appState,
        presentation: { ...appState.presentation, groups },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

export const actionSetGroupOpacityMode = register<{
  groupId: string;
  mode: "step-wise" | "highlight";
}>({
  name: "setPresentationGroupOpacityMode",
  label: "labels.presentation.setGroupOpacityMode",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, formData) => {
    if (!formData) {
      return false;
    }
    const groups = (appState.presentation.groups ?? []).map((g) => {
      if (g.id !== formData.groupId) {
        return g;
      }
      // Default mode (step-wise) is stored as undefined to keep saved files clean.
      const next: typeof g = { ...g };
      if (formData.mode === "step-wise") {
        delete next.opacityMode;
      } else {
        next.opacityMode = formData.mode;
      }
      return next;
    });
    return {
      appState: {
        ...appState,
        presentation: { ...appState.presentation, groups },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionSetActivePresentationGroup = register<string | null>({
  name: "setActivePresentationGroup",
  label: "labels.presentation.setActiveGroup",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, groupId: string | null | undefined) => {
    const next = groupId === undefined ? null : groupId;
    // When switching the group filter, also clear the active step preview if
    // it doesn't belong to the new group, so the preview matches the filter.
    const activeStep = appState.presentation.steps.find(
      (s) => s.id === appState.presentation.activeStepId,
    );
    const stepStillVisible =
      next == null || (activeStep && (activeStep.groupId ?? null) === next);
    return {
      appState: {
        ...appState,
        presentation: {
          ...appState.presentation,
          activeGroupId: next,
          activeStepId: stepStillVisible
            ? appState.presentation.activeStepId
            : null,
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

// =============================================================================
// Element ↔ step membership (multi-step)
// =============================================================================

export const actionAddSelectionToStep = register<string | null>({
  name: "assignSelectionToPresentationStep",
  label: "labels.presentation.addToStep",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, stepId: string | null | undefined, app) => {
    if (!stepId) {
      return false;
    }
    const selectedIds = getSelectedIdsForPresentation(appState, app);
    const nextElements = elements.map((el) => {
      if (!selectedIds.has(el.id)) {
        return el;
      }
      const data = presentationOf(el) ?? {};
      const ids = getRevealStepIds(el);
      ids.add(stepId);
      // Adding to a reveal step is mutually exclusive with alwaysFull —
      // pinning everywhere defeats step-by-step reveal.
      return withPresentation(el, {
        ...data,
        revealAtStepIds: Array.from(ids),
        alwaysFull: false,
      });
    });
    return {
      elements: nextElements,
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

// Kept for backwards-compatible action name resolution; semantically identical to add.
export const actionAssignSelectionToStep = actionAddSelectionToStep;

export const actionRemoveSelectionFromStep = register<string | null>({
  name: "removeSelectionFromPresentationStep",
  label: "labels.presentation.removeFromStep",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, stepId: string | null | undefined, app) => {
    if (!stepId) {
      return false;
    }
    const selectedIds = getSelectedIdsForPresentation(appState, app);
    const nextElements = elements.map((el) => {
      if (!selectedIds.has(el.id)) {
        return el;
      }
      const ids = getRevealStepIds(el);
      if (!ids.has(stepId)) {
        return el;
      }
      ids.delete(stepId);
      const data = presentationOf(el) ?? {};
      const remaining = Array.from(ids);
      if (remaining.length === 0 && !data.alwaysFull) {
        return withPresentation(el, null);
      }
      return withPresentation(el, {
        ...data,
        revealAtStepIds: remaining,
      });
    });
    return {
      elements: nextElements,
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

/**
 * Toggles always-full pin on the selection, scoped to the active step's
 * diagram. If the active step is in DiagA, this pins/unpins the selection
 * in DiagA only — other diagrams are unaffected. The legacy global
 * `alwaysFull` boolean is also cleared on toggle-off so the pin truly goes
 * away for the active diagram.
 */
export const actionToggleSelectionAlwaysFull = register({
  name: "toggleSelectionAlwaysFull",
  label: "labels.presentation.toggleAlwaysFull",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, _, app) => {
    const activeStep = appState.presentation.steps.find(
      (s) => s.id === appState.presentation.activeStepId,
    );
    if (!activeStep) {
      return false;
    }
    const groupKey = groupKeyOf(activeStep.groupId ?? null);
    const selectedIds = getSelectedIdsForPresentation(appState, app);

    // "On" for this active group = legacy global pin OR per-diagram set includes group.
    const isOnForActiveGroup = (el: ExcalidrawElement) => {
      const data = presentationOf(el);
      if (!data) {
        return false;
      }
      return (
        !!data.alwaysFull || !!data.alwaysFullGroupIds?.includes(groupKey)
      );
    };

    let anyOn = false;
    for (const el of elements) {
      if (selectedIds.has(el.id) && isOnForActiveGroup(el)) {
        anyOn = true;
        break;
      }
    }
    const turnOn = !anyOn;

    const nextElements = elements.map((el) => {
      if (!selectedIds.has(el.id)) {
        return el;
      }
      const data = presentationOf(el) ?? {};
      const current = new Set(data.alwaysFullGroupIds ?? []);
      if (turnOn) {
        current.add(groupKey);
        return withPresentation(el, {
          ...data,
          alwaysFullGroupIds: Array.from(current),
        });
      }
      // Turn off in active group: drop from per-diagram set AND clear the
      // legacy global pin so the off state is honoured here.
      current.delete(groupKey);
      const next: PresentationCustomData = { ...data };
      delete next.alwaysFull;
      if (current.size === 0) {
        delete next.alwaysFullGroupIds;
      } else {
        next.alwaysFullGroupIds = Array.from(current);
      }
      return withPresentation(el, next);
    });
    return {
      elements: nextElements,
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionClearSelectionStepTags = register({
  name: "clearSelectionStepTags",
  label: "labels.presentation.clearTags",
  trackEvent: { category: "presentation" },
  perform: (elements, appState, _, app) => {
    const selectedIds = getSelectedIdsForPresentation(appState, app);
    const nextElements = elements.map((el) => {
      if (!selectedIds.has(el.id) || !el.customData?.presentation) {
        return el;
      }
      return withPresentation(el, null);
    });
    return {
      elements: nextElements,
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
