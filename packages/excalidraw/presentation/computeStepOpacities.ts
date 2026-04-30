import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState } from "../types";

/**
 * Sentinel used in `alwaysFullGroupIds` to represent the "unassigned" diagram
 * bucket (steps with `groupId == null`). Empty string is JSON-friendly and
 * stays out of the way of real (random-id) group ids.
 */
export const UNASSIGNED_GROUP_KEY = "";

export type PresentationCustomData = {
  /** Multi-step membership: every step the element is revealed at full opacity in. */
  revealAtStepIds?: string[];
  /** Legacy single-step membership; still read for backwards compatibility. */
  revealAtStepId?: string | null;
  /** Legacy global pin: full opacity in every diagram. */
  alwaysFull?: boolean;
  /**
   * Per-diagram pin: full opacity only when the active step belongs to one of
   * these groups. Use UNASSIGNED_GROUP_KEY to represent the unassigned bucket.
   */
  alwaysFullGroupIds?: string[];
};

/** Returns the diagram key for a given group id (real id or unassigned sentinel). */
export const groupKeyOf = (groupId: string | null | undefined): string =>
  groupId == null ? UNASSIGNED_GROUP_KEY : groupId;

export const getPresentationData = (
  element: ExcalidrawElement,
): PresentationCustomData | null => {
  const raw = element.customData?.presentation;
  return raw && typeof raw === "object" ? (raw as PresentationCustomData) : null;
};

/**
 * Returns the full set of step ids this element is revealed at, merging the
 * new `revealAtStepIds` array with the legacy single `revealAtStepId` field
 * so older data keeps working.
 */
export const getRevealStepIds = (
  element: ExcalidrawElement,
): Set<string> => {
  const data = getPresentationData(element);
  const out = new Set<string>();
  if (!data) {
    return out;
  }
  if (data.revealAtStepIds) {
    for (const id of data.revealAtStepIds) {
      if (id) {
        out.add(id);
      }
    }
  }
  if (data.revealAtStepId) {
    out.add(data.revealAtStepId);
  }
  return out;
};

/**
 * Bound text elements (text inside a container, or labels on arrows) are
 * separate elements — they don't appear in the user's selection when they
 * click the container/arrow. Build a map from each bound text's id to its
 * parent container's id so we can inherit presentation tags when the parent
 * is tagged but the child wasn't.
 */
const buildBoundTextParentMap = (
  elements: readonly ExcalidrawElement[],
): Map<string, string> => {
  const parentByText = new Map<string, string>();
  for (const el of elements) {
    if (el.isDeleted || !("boundElements" in el) || !el.boundElements) {
      continue;
    }
    for (const bound of el.boundElements) {
      if (bound.type === "text") {
        parentByText.set(bound.id, el.id);
      }
    }
  }
  return parentByText;
};

/**
 * Returns a per-element opacity multiplier (0..1) for the active presentation
 * step, or `null` when no step is active (caller should skip dimming entirely).
 *
 * Classification mirrors the Python pipeline's past/current/future model:
 * - alwaysFull pin → 1.0 on every step
 * - revealAtStepId === activeStepId → 1.0 (current)
 * - revealAtStepId is at an earlier step → pastOpacity
 * - revealAtStepId is null or at a later step → futureOpacity
 */
export const computeStepOpacities = (
  elements: readonly ExcalidrawElement[],
  presentation: AppState["presentation"],
): Map<string, number> | null => {
  const { steps, activeStepId } = presentation;
  if (activeStepId == null) {
    return null;
  }
  const activeIndex = steps.findIndex((s) => s.id === activeStepId);
  if (activeIndex < 0) {
    return null;
  }

  // Group filter: only steps in the active step's group participate in
  // past/current/future classification. Elements pointing at a step in a
  // different group are treated like untagged → futureOpacity, so each
  // diagram's reveal is self-contained.
  const activeStep = steps[activeIndex];
  const activeGroupId = activeStep.groupId ?? null;
  const activeGroupKey = groupKeyOf(activeGroupId);

  // Per-diagram opacity overrides fall back to the global values.
  const activeGroup =
    activeGroupId != null
      ? presentation.groups?.find((g) => g.id === activeGroupId)
      : undefined;
  const opacityMode = activeGroup?.opacityMode ?? "step-wise";
  const pastOpacity = activeGroup?.pastOpacity ?? presentation.pastOpacity;
  const futureOpacity =
    activeGroup?.futureOpacity ?? presentation.futureOpacity;
  // In highlight mode, "past" doesn't exist — anything not current fades
  // uniformly to the non-selected opacity (using futureOpacity as the value).
  const nonCurrentOpacity =
    opacityMode === "highlight" ? futureOpacity : null;

  const stepIndexById = new Map<string, number>();
  // Index only steps in the active group; out-of-group steps are intentionally
  // omitted so revealAtStepId pointing at them resolves as "not in this flow".
  const stepsInGroup = steps.filter(
    (s) => (s.groupId ?? null) === activeGroupId,
  );
  stepsInGroup.forEach((s, i) => stepIndexById.set(s.id, i));
  const activeIndexInGroup = stepsInGroup.findIndex(
    (s) => s.id === activeStepId,
  );

  const parentByText = buildBoundTextParentMap(elements);
  const elementById = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    elementById.set(el.id, el);
  }

  const out = new Map<string, number>();
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    // Bound text inherits its container/arrow's presentation tag when the
    // child is untagged — so labels on arrows and text inside shapes follow
    // their parent automatically.
    let effectiveElement: ExcalidrawElement = element;
    const ownData = getPresentationData(element);
    const ownIds = getRevealStepIds(element);
    if (!ownData?.alwaysFull && ownIds.size === 0) {
      const parentId = parentByText.get(element.id);
      if (parentId) {
        const parent = elementById.get(parentId);
        if (parent) {
          effectiveElement = parent;
        }
      }
    }
    const data = getPresentationData(effectiveElement);
    // Always-full pin: legacy boolean (pinned everywhere) OR per-diagram set.
    if (
      data?.alwaysFull ||
      data?.alwaysFullGroupIds?.includes(activeGroupKey)
    ) {
      out.set(element.id, 1);
      continue;
    }
    const revealIds = getRevealStepIds(effectiveElement);
    if (revealIds.size === 0) {
      out.set(element.id, futureOpacity);
      continue;
    }
    // Multi-step membership: classification picks the strongest match.
    // - any id matches active step → current (1.0)
    // - else any id is at an earlier index in the active group → past
    // - else (all ids are out-of-group, deleted, or later) → future
    let isCurrent = false;
    let hasPast = false;
    for (const id of revealIds) {
      if (id === activeStepId) {
        isCurrent = true;
        break;
      }
      const idx = stepIndexById.get(id);
      if (idx != null && idx < activeIndexInGroup) {
        hasPast = true;
      }
    }
    if (isCurrent) {
      out.set(element.id, 1);
    } else if (nonCurrentOpacity != null) {
      // Highlight mode: collapse past/future into a single "non-selected" value.
      out.set(element.id, nonCurrentOpacity);
    } else if (hasPast) {
      out.set(element.id, pastOpacity);
    } else {
      out.set(element.id, futureOpacity);
    }
  }
  return out;
};
