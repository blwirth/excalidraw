import { computeStepOpacities } from "../../presentation/computeStepOpacities";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "../../types";

const makeEl = (
  id: string,
  customData?: Record<string, any>,
): ExcalidrawElement =>
  ({
    id,
    type: "rectangle",
    isDeleted: false,
    customData,
  } as unknown as ExcalidrawElement);

const presentation = (
  overrides: Partial<AppState["presentation"]> = {},
): AppState["presentation"] => ({
  steps: [
    { id: "s1", name: "One" },
    { id: "s2", name: "Two" },
    { id: "s3", name: "Three" },
  ],
  groups: [],
  activeGroupId: null,
  activeStepId: null,
  pastOpacity: 0.5,
  futureOpacity: 0.2,
  ...overrides,
});

describe("computeStepOpacities", () => {
  it("returns null when no active step", () => {
    expect(
      computeStepOpacities([makeEl("a")], presentation({ activeStepId: null })),
    ).toBeNull();
  });

  it("returns null when activeStepId references a missing step", () => {
    expect(
      computeStepOpacities(
        [makeEl("a")],
        presentation({ activeStepId: "ghost" }),
      ),
    ).toBeNull();
  });

  it("classifies past/current/future relative to active step (single membership)", () => {
    const elements = [
      makeEl("a", { presentation: { revealAtStepIds: ["s1"] } }),
      makeEl("b", { presentation: { revealAtStepIds: ["s2"] } }),
      makeEl("c", { presentation: { revealAtStepIds: ["s3"] } }),
    ];
    const map = computeStepOpacities(
      elements,
      presentation({ activeStepId: "s2" }),
    );
    expect(map?.get("a")).toBe(0.5);
    expect(map?.get("b")).toBe(1);
    expect(map?.get("c")).toBe(0.2);
  });

  it("supports multi-step membership", () => {
    // element belongs to step 1 AND step 3
    const el = makeEl("multi", {
      presentation: { revealAtStepIds: ["s1", "s3"] },
    });
    // Active s1 → current
    expect(
      computeStepOpacities([el], presentation({ activeStepId: "s1" }))?.get(
        "multi",
      ),
    ).toBe(1);
    // Active s2 → past (s1 is earlier)
    expect(
      computeStepOpacities([el], presentation({ activeStepId: "s2" }))?.get(
        "multi",
      ),
    ).toBe(0.5);
    // Active s3 → current
    expect(
      computeStepOpacities([el], presentation({ activeStepId: "s3" }))?.get(
        "multi",
      ),
    ).toBe(1);
  });

  it("treats untagged elements as future", () => {
    const map = computeStepOpacities(
      [makeEl("a")],
      presentation({ activeStepId: "s2" }),
    );
    expect(map?.get("a")).toBe(0.2);
  });

  it("reads legacy single-id revealAtStepId", () => {
    const el = makeEl("legacy", { presentation: { revealAtStepId: "s2" } });
    const map = computeStepOpacities(
      [el],
      presentation({ activeStepId: "s2" }),
    );
    expect(map?.get("legacy")).toBe(1);
  });

  it("merges legacy single-id with new array", () => {
    const el = makeEl("merged", {
      presentation: { revealAtStepId: "s1", revealAtStepIds: ["s3"] },
    });
    // Active s2 → past (s1 is earlier)
    expect(
      computeStepOpacities([el], presentation({ activeStepId: "s2" }))?.get(
        "merged",
      ),
    ).toBe(0.5);
  });

  it("alwaysFull elements stay at 1 on every step", () => {
    const el = makeEl("title", { presentation: { alwaysFull: true } });
    for (const stepId of ["s1", "s2", "s3"]) {
      const map = computeStepOpacities(
        [el],
        presentation({ activeStepId: stepId }),
      );
      expect(map?.get("title")).toBe(1);
    }
  });

  it("alwaysFull wins over revealAtStepIds", () => {
    const el = makeEl("title", {
      presentation: { alwaysFull: true, revealAtStepIds: ["s2"] },
    });
    const map = computeStepOpacities(
      [el],
      presentation({ activeStepId: "s1" }),
    );
    expect(map?.get("title")).toBe(1);
  });

  it("respects custom past/future opacities", () => {
    const elements = [
      makeEl("a", { presentation: { revealAtStepIds: ["s1"] } }),
      makeEl("b", { presentation: { revealAtStepIds: ["s3"] } }),
    ];
    const map = computeStepOpacities(
      elements,
      presentation({ activeStepId: "s2", pastOpacity: 0.3, futureOpacity: 0.1 }),
    );
    expect(map?.get("a")).toBe(0.3);
    expect(map?.get("b")).toBe(0.1);
  });

  it("skips deleted elements", () => {
    const live = makeEl("a", { presentation: { revealAtStepIds: ["s1"] } });
    const dead = {
      ...makeEl("b", { presentation: { revealAtStepIds: ["s1"] } }),
      isDeleted: true,
    } as ExcalidrawElement;
    const map = computeStepOpacities(
      [live, dead],
      presentation({ activeStepId: "s1" }),
    );
    expect(map?.has("a")).toBe(true);
    expect(map?.has("b")).toBe(false);
  });

  describe("groups", () => {
    const groupedPresentation = (
      activeStepId: string,
    ): AppState["presentation"] => ({
      steps: [
        { id: "a1", name: "A1", groupId: "ga" },
        { id: "a2", name: "A2", groupId: "ga" },
        { id: "b1", name: "B1", groupId: "gb" },
        { id: "b2", name: "B2", groupId: "gb" },
      ],
      groups: [
        { id: "ga", name: "DiagA" },
        { id: "gb", name: "DiagB" },
      ],
      activeGroupId: null,
      activeStepId,
      pastOpacity: 0.5,
      futureOpacity: 0.2,
    });

    it("only classifies elements within the active step's group", () => {
      const inA = makeEl("inA", {
        presentation: { revealAtStepIds: ["a1"] },
      });
      const inB = makeEl("inB", {
        presentation: { revealAtStepIds: ["b1"] },
      });
      // Active = b2 (group B). inA points to group A → treated as future.
      const map = computeStepOpacities([inA, inB], groupedPresentation("b2"));
      expect(map?.get("inA")).toBe(0.2);
      expect(map?.get("inB")).toBe(0.5);
    });

    it("element in multiple groups is current in whichever group is active", () => {
      const both = makeEl("both", {
        presentation: { revealAtStepIds: ["a2", "b1"] },
      });
      expect(
        computeStepOpacities([both], groupedPresentation("a2"))?.get("both"),
      ).toBe(1);
      expect(
        computeStepOpacities([both], groupedPresentation("b1"))?.get("both"),
      ).toBe(1);
      // Active = a1 (group A). Membership in group A: a2 (later) → future for group A flow.
      expect(
        computeStepOpacities([both], groupedPresentation("a1"))?.get("both"),
      ).toBe(0.2);
    });
  });

  describe("highlight mode", () => {
    it("collapses past/future into the futureOpacity value when group is in highlight mode", () => {
      const presentationWithHighlight: AppState["presentation"] = {
        steps: [
          { id: "h1", name: "1", groupId: "gh" },
          { id: "h2", name: "2", groupId: "gh" },
          { id: "h3", name: "3", groupId: "gh" },
        ],
        groups: [
          {
            id: "gh",
            name: "Highlight",
            opacityMode: "highlight",
            pastOpacity: 0.99,
            futureOpacity: 0.15,
          },
        ],
        activeGroupId: null,
        activeStepId: "h2",
        pastOpacity: 0.5,
        futureOpacity: 0.2,
      };
      const elements = [
        makeEl("a", { presentation: { revealAtStepIds: ["h1"] } }),
        makeEl("b", { presentation: { revealAtStepIds: ["h2"] } }),
        makeEl("c", { presentation: { revealAtStepIds: ["h3"] } }),
      ];
      const map = computeStepOpacities(elements, presentationWithHighlight);
      // Active is h2 → b is current. a and c (past + future) both fade to 0.15
      // (the futureOpacity value, used as the "non-selected" opacity).
      expect(map?.get("a")).toBe(0.15);
      expect(map?.get("b")).toBe(1);
      expect(map?.get("c")).toBe(0.15);
    });

    it("step-wise mode is the default when opacityMode is omitted", () => {
      const presentationWithGroup: AppState["presentation"] = {
        steps: [
          { id: "s1", name: "1", groupId: "gd" },
          { id: "s2", name: "2", groupId: "gd" },
        ],
        groups: [{ id: "gd", name: "Default" }],
        activeGroupId: null,
        activeStepId: "s2",
        pastOpacity: 0.5,
        futureOpacity: 0.2,
      };
      const el = makeEl("a", { presentation: { revealAtStepIds: ["s1"] } });
      // Past (not faded uniformly) → 0.5
      expect(
        computeStepOpacities([el], presentationWithGroup)?.get("a"),
      ).toBe(0.5);
    });
  });

  describe("bound text inheritance", () => {
    it("bound text inherits its container's tags", () => {
      const container = {
        id: "c1",
        type: "rectangle",
        isDeleted: false,
        boundElements: [{ id: "t1", type: "text" }],
        customData: { presentation: { revealAtStepIds: ["s2"] } },
      } as unknown as ExcalidrawElement;
      const text = {
        id: "t1",
        type: "text",
        isDeleted: false,
        containerId: "c1",
      } as unknown as ExcalidrawElement;
      const map = computeStepOpacities(
        [container, text],
        presentation({ activeStepId: "s2" }),
      );
      expect(map?.get("c1")).toBe(1);
      expect(map?.get("t1")).toBe(1);
    });
  });
});
