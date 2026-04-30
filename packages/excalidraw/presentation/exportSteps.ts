import { exportToSvg } from "../scene/export";

import {
  computeStepOpacities,
  getPresentationData,
  getRevealStepIds,
  groupKeyOf,
  UNASSIGNED_GROUP_KEY,
} from "./computeStepOpacities";

import type { ExcalidrawElement, NonDeleted } from "@excalidraw/element/types";
import type { AppState, BinaryFiles, UIAppState } from "../types";

type PresentationExportAppState = Pick<
  AppState,
  | "presentation"
  | "exportBackground"
  | "viewBackgroundColor"
  | "exportWithDarkMode"
  | "exportScale"
  | "frameRendering"
  | "name"
> &
  Partial<UIAppState>;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Auto-generated names look like "Step 1", "Step 12", etc. — skip them in filenames. */
const DEFAULT_STEP_NAME_RE = /^step\s+\d+$/i;
const isDefaultStepName = (name: string) => DEFAULT_STEP_NAME_RE.test(name.trim());

/**
 * Builds a map: bound-text element id → parent container id, so an element
 * tagged "in this diagram" can pull its label/text in for free.
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
 * Returns the subset of elements that participate in the given diagram, i.e.
 * either (a) they're revealed at any step within it, (b) they're pinned via
 * alwaysFullGroupIds for this diagram, or (c) they carry the legacy global
 * alwaysFull pin. Bound text inherits its container's membership.
 */
const filterElementsForDiagram = (
  elements: readonly NonDeleted<ExcalidrawElement>[],
  diagramStepIds: Set<string>,
  diagramGroupKey: string,
): NonDeleted<ExcalidrawElement>[] => {
  const parentByText = buildBoundTextParentMap(elements);
  const elementById = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    elementById.set(el.id, el);
  }

  const isOwnInDiagram = (el: ExcalidrawElement) => {
    const data = getPresentationData(el);
    if (data?.alwaysFull) {
      return true;
    }
    if (data?.alwaysFullGroupIds?.includes(diagramGroupKey)) {
      return true;
    }
    for (const id of getRevealStepIds(el)) {
      if (diagramStepIds.has(id)) {
        return true;
      }
    }
    return false;
  };

  return elements.filter((el) => {
    if (isOwnInDiagram(el)) {
      return true;
    }
    // Inherit membership from container (bound text follows its parent).
    const parentId = parentByText.get(el.id);
    if (parentId) {
      const parent = elementById.get(parentId);
      if (parent && isOwnInDiagram(parent)) {
        return true;
      }
    }
    return false;
  });
};

/** Export-shape for a single diagram (one SVG per step, with the diagram-filtered element set). */
const buildDiagramStepSvgs = async ({
  elements,
  appState,
  files,
  baseName,
  diagramSlugPrefix,
  diagramSteps,
  diagramGroupKey,
}: {
  elements: readonly NonDeleted<ExcalidrawElement>[];
  appState: PresentationExportAppState;
  files: BinaryFiles | null;
  baseName: string;
  diagramSlugPrefix: string; // e.g. "bager-" or "" for unassigned
  diagramSteps: AppState["presentation"]["steps"];
  diagramGroupKey: string;
}): Promise<Array<{ filename: string; svg: string }>> => {
  const diagramStepIdSet = new Set(diagramSteps.map((s) => s.id));
  const elementsInDiagram = filterElementsForDiagram(
    elements,
    diagramStepIdSet,
    diagramGroupKey,
  );

  if (elementsInDiagram.length === 0 || diagramSteps.length === 0) {
    return [];
  }

  const out: Array<{ filename: string; svg: string }> = [];
  for (let i = 0; i < diagramSteps.length; i++) {
    const step = diagramSteps[i];
    // Compute opacities using only this diagram's steps so classification is
    // self-contained and matches the live preview for this diagram.
    const opacityMap = computeStepOpacities(elementsInDiagram, {
      ...appState.presentation,
      steps: diagramSteps,
      activeStepId: step.id,
    });

    const stepElements = opacityMap
      ? elementsInDiagram.map((el) => {
          const mult = opacityMap.get(el.id);
          if (mult == null || mult === 1) {
            return el;
          }
          const nextOpacity = Math.max(0, Math.min(100, el.opacity * mult));
          return { ...el, opacity: nextOpacity } as ExcalidrawElement;
        })
      : elementsInDiagram;

    const svgEl = await exportToSvg(
      stepElements as readonly NonDeleted<ExcalidrawElement>[],
      {
        exportBackground: appState.exportBackground,
        viewBackgroundColor: appState.viewBackgroundColor,
        exportWithDarkMode: appState.exportWithDarkMode,
        exportEmbedScene: false,
        exportScale: appState.exportScale,
        frameRendering: appState.frameRendering,
      },
      files,
      { skipInliningFonts: true },
    );

    const stepSuffix = isDefaultStepName(step.name)
      ? ""
      : `-${slugify(step.name) || "untitled"}`;
    const filename = `${baseName}-${diagramSlugPrefix}step-${String(
      i + 1,
    ).padStart(2, "0")}${stepSuffix}.svg`;
    out.push({ filename, svg: svgEl.outerHTML });
  }
  return out;
};

/**
 * Public entrypoint: builds SVGs for the export scope chosen in the panel.
 * - If a specific diagram is the active filter: exports just that diagram.
 * - If "All steps" is active: exports every diagram and the unassigned bucket
 *   in turn, prefixing each filename with the diagram slug. Diagrams with no
 *   participating elements are skipped.
 */
export const buildPresentationStepSvgs = async ({
  elements,
  appState,
  files,
  baseName,
}: {
  elements: readonly NonDeleted<ExcalidrawElement>[];
  appState: PresentationExportAppState;
  files: BinaryFiles | null;
  baseName: string;
}): Promise<Array<{ filename: string; svg: string }>> => {
  const { presentation } = appState;
  const baseSlug = slugify(baseName) || "drawing";

  // Determine which diagrams to export.
  type DiagramExportSpec = {
    name: string;
    groupId: string | null;
    steps: AppState["presentation"]["steps"];
  };
  const allGroups = presentation.groups ?? [];
  const targets: DiagramExportSpec[] = [];

  if (presentation.activeGroupId) {
    const g = allGroups.find((gg) => gg.id === presentation.activeGroupId);
    if (g) {
      targets.push({
        name: g.name,
        groupId: g.id,
        steps: presentation.steps.filter(
          (s) => (s.groupId ?? null) === g.id,
        ),
      });
    }
  } else {
    // All-steps mode: one export pass per diagram + an "unassigned" pass.
    for (const g of allGroups) {
      targets.push({
        name: g.name,
        groupId: g.id,
        steps: presentation.steps.filter((s) => (s.groupId ?? null) === g.id),
      });
    }
    const unassignedSteps = presentation.steps.filter(
      (s) => (s.groupId ?? null) === null,
    );
    if (unassignedSteps.length > 0) {
      targets.push({
        name: "Unassigned",
        groupId: null,
        steps: unassignedSteps,
      });
    }
  }

  const out: Array<{ filename: string; svg: string }> = [];
  for (const t of targets) {
    // Include the diagram name in every export (skip only for the unassigned
    // bucket since it doesn't really have a title).
    const diagramSlugPrefix =
      t.groupId == null ? "" : `${slugify(t.name) || "diagram"}-`;
    const built = await buildDiagramStepSvgs({
      elements,
      appState,
      files,
      baseName: baseSlug,
      diagramSlugPrefix,
      diagramSteps: t.steps,
      diagramGroupKey: groupKeyOf(t.groupId),
    });
    out.push(...built);
  }
  return out;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const exportPresentationStepsToFiles = async (args: {
  elements: readonly NonDeleted<ExcalidrawElement>[];
  appState: PresentationExportAppState;
  files: BinaryFiles | null;
  baseName: string;
}): Promise<number> => {
  const svgs = await buildPresentationStepSvgs(args);
  for (const { filename, svg } of svgs) {
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), filename);
    await new Promise((r) => setTimeout(r, 50));
  }
  return svgs.length;
};

// Re-exports so callers don't need to know the internal module layout.
export { UNASSIGNED_GROUP_KEY };
