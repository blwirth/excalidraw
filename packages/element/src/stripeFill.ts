import { applyDarkModeFilter, isTransparent } from "@excalidraw/common";

import type { ExcalidrawElement, NonDeletedExcalidrawElement } from "./types";

import {
  getDatabaseCapHeight,
  getDiamondPoints,
  getParallelogramPoints,
} from "./bounds";
import { getCornerRadius, isPathALoop } from "./utils";
import { isFreeDrawElement, isLinearElement } from "./typeChecks";

export const STRIPE_WIDTH = 8;

export const hasStripeFill = (element: ExcalidrawElement) =>
  !!element.secondaryBackgroundColor &&
  !isTransparent(element.secondaryBackgroundColor);

/**
 * Build an SVG path "d" string matching the element's fill silhouette in
 * element-local coordinates. Used for both canvas (via `new Path2D(d)`) and
 * SVG export (as a `<path d="..." />` attribute). Returns null for element
 * types we don't render stripes for.
 */
export const getElementFillPathD = (
  element: NonDeletedExcalidrawElement,
): string | null => {
  switch (element.type) {
    case "rectangle":
    case "iframe":
    case "embeddable": {
      const w = element.width;
      const h = element.height;
      if (element.roundness) {
        const r = getCornerRadius(Math.min(w, h), element);
        return (
          `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} ` +
          `L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} ` +
          `L ${r} ${h} Q 0 ${h} 0 ${h - r} ` +
          `L 0 ${r} Q 0 0 ${r} 0 Z`
        );
      }
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
    }
    case "ellipse": {
      const rx = element.width / 2;
      const ry = element.height / 2;
      // Two arcs joined to form a full ellipse.
      return (
        `M 0 ${ry} ` +
        `A ${rx} ${ry} 0 1 0 ${element.width} ${ry} ` +
        `A ${rx} ${ry} 0 1 0 0 ${ry} Z`
      );
    }
    case "diamond": {
      const [topX, topY, rightX, rightY, bottomX, bottomY, leftX, leftY] =
        getDiamondPoints(element);
      return (
        `M ${topX} ${topY} L ${rightX} ${rightY} ` +
        `L ${bottomX} ${bottomY} L ${leftX} ${leftY} Z`
      );
    }
    case "parallelogram": {
      const [tlX, tlY, trX, trY, brX, brY, blX, blY] =
        getParallelogramPoints(element);
      return (
        `M ${tlX} ${tlY} L ${trX} ${trY} ` +
        `L ${brX} ${brY} L ${blX} ${blY} Z`
      );
    }
    case "database": {
      const w = element.width;
      const h = element.height;
      const cap = getDatabaseCapHeight(element);
      const rx = w / 2;
      // Mirrors shape.ts bodyPath: top half-ellipse, right edge, bottom
      // half-ellipse, left edge.
      return (
        `M 0 ${cap} ` +
        `A ${rx} ${cap} 0 0 1 ${w} ${cap} ` +
        `L ${w} ${h - cap} ` +
        `A ${rx} ${cap} 0 0 1 0 ${h - cap} Z`
      );
    }
    default: {
      if (
        (isLinearElement(element) || isFreeDrawElement(element)) &&
        isPathALoop(element.points)
      ) {
        const points = element.points;
        let d = `M ${points[0][0]} ${points[0][1]}`;
        for (let i = 1; i < points.length; i++) {
          d += ` L ${points[i][0]} ${points[i][1]}`;
        }
        d += " Z";
        return d;
      }
      return null;
    }
  }
};

const resolveColor = (color: string, isDarkMode: boolean) =>
  isDarkMode ? applyDarkModeFilter(color) : color;

/**
 * Paint the two-color diagonal-stripe fill for an element. Caller must already
 * have translated/rotated the canvas so that (0,0) is the element's top-left
 * corner in element-local space. Stripes are drawn as continuous lines at
 * 45° so they remain unbroken across the shape.
 */
export const drawStripeFill = (
  context: CanvasRenderingContext2D,
  element: NonDeletedExcalidrawElement,
  isDarkMode: boolean,
) => {
  if (!hasStripeFill(element)) {
    return;
  }
  const d = getElementFillPathD(element);
  if (!d) {
    return;
  }

  const primary = element.backgroundColor;
  const secondary = element.secondaryBackgroundColor!;
  const w = element.width;
  const h = element.height;
  const pad = 2;

  context.save();
  context.clip(new Path2D(d));

  if (!isTransparent(primary)) {
    context.fillStyle = resolveColor(primary, isDarkMode);
    context.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
  }

  context.strokeStyle = resolveColor(secondary, isDarkMode);
  context.lineWidth = STRIPE_WIDTH;
  context.lineCap = "butt";

  const period = STRIPE_WIDTH * 2;
  const startX = -h - pad * 2;
  const endX = w + pad * 2 + period;
  const firstX = Math.floor(startX / period) * period;

  context.beginPath();
  for (let x = firstX; x <= endX; x += period) {
    context.moveTo(x, 0);
    context.lineTo(x + h + pad * 2, h + pad * 2);
  }
  context.stroke();

  context.restore();
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build the SVG fragment for a striped fill: a `<defs>`-scoped pattern of
 * diagonal lines plus a path that fills the element silhouette with that
 * pattern. The returned `<g>` is meant to be appended to the SVG render tree
 * BEFORE the rough stroke node so it sits underneath.
 *
 * Returns null if the element shouldn't be striped or has no path geometry.
 */
export const renderSvgStripeFill = (
  element: NonDeletedExcalidrawElement,
  svgRoot: SVGElement,
  isDarkMode: boolean,
): { fillNode: SVGElement; defsNodes: SVGElement[] } | null => {
  if (!hasStripeFill(element)) {
    return null;
  }
  const d = getElementFillPathD(element);
  if (!d) {
    return null;
  }

  const primary = element.backgroundColor;
  const secondary = element.secondaryBackgroundColor!;
  const resolvedPrimary = isTransparent(primary)
    ? null
    : resolveColor(primary, isDarkMode);
  const resolvedSecondary = resolveColor(secondary, isDarkMode);

  const period = STRIPE_WIDTH * 2;
  const patternId = `stripe-${element.id}`;
  const doc = svgRoot.ownerDocument!;

  const pattern = doc.createElementNS(SVG_NS, "pattern");
  pattern.setAttribute("id", patternId);
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", String(period));
  pattern.setAttribute("height", String(period));
  // Rotate so horizontal stripes in pattern space become 45° in user space.
  pattern.setAttribute("patternTransform", "rotate(45)");

  if (resolvedPrimary) {
    const bg = doc.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", String(period));
    bg.setAttribute("height", String(period));
    bg.setAttribute("fill", resolvedPrimary);
    pattern.appendChild(bg);
  }

  const stripe = doc.createElementNS(SVG_NS, "rect");
  stripe.setAttribute("width", String(period));
  stripe.setAttribute("height", String(STRIPE_WIDTH));
  stripe.setAttribute("fill", resolvedSecondary);
  pattern.appendChild(stripe);

  const fillNode = doc.createElementNS(SVG_NS, "path");
  fillNode.setAttribute("d", d);
  fillNode.setAttribute("fill", `url(#${patternId})`);
  fillNode.setAttribute("stroke", "none");

  return { fillNode, defsNodes: [pattern] };
};
