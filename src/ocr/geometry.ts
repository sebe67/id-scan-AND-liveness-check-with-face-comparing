export interface Point {
  x: number;
  y: number;
}

/**
 * 4-connected flood fill over a binary bitmap. Iterative (stack-based) to avoid
 * blowing the call stack on large connected blobs.
 */
export function findConnectedComponents(
  binary: Uint8Array,
  width: number,
  height: number,
  minPixels = 4
): Point[][] {
  const visited = new Uint8Array(width * height);
  const components: Point[][] = [];

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const startIdx = sy * width + sx;
      if (!binary[startIdx] || visited[startIdx]) continue;

      const pts: Point[] = [];
      const stack: Point[] = [{ x: sx, y: sy }];
      visited[startIdx] = 1;

      while (stack.length) {
        const { x, y } = stack.pop()!;
        pts.push({ x, y });
        const neighbors: Point[] = [
          { x: x - 1, y },
          { x: x + 1, y },
          { x, y: y - 1 },
          { x, y: y + 1 },
        ];
        for (const nb of neighbors) {
          if (nb.x < 0 || nb.x >= width || nb.y < 0 || nb.y >= height) continue;
          const nIdx = nb.y * width + nb.x;
          if (!visited[nIdx] && binary[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nb);
          }
        }
      }

      if (pts.length >= minPixels) components.push(pts);
    }
  }

  return components;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain convex hull. */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const n = pts.length;
  if (n < 3) return pts;

  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface RotatedRect {
  center: Point;
  width: number;
  height: number;
  /** Radians; rotation of the rect's "width" edge relative to the x-axis. */
  angle: number;
  corners: [Point, Point, Point, Point];
}

export function rectCorners(center: Point, width: number, height: number, angle: number): [Point, Point, Point, Point] {
  const hw = width / 2;
  const hh = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map((p) => ({
    x: center.x + p.x * cos - p.y * sin,
    y: center.y + p.x * sin + p.y * cos,
  })) as [Point, Point, Point, Point];
}

/**
 * Minimum-area bounding rectangle over a convex hull, via rotating calipers
 * (equivalent to OpenCV's cv2.minAreaRect, which PaddleOCR's DB postprocessing uses
 * to turn a detected text blob into a box).
 */
export function minAreaRect(hull: Point[]): RotatedRect {
  let best: RotatedRect | null = null;
  const n = hull.length;

  for (let i = 0; i < n; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % n];
    const edgeAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }

    const w = maxX - minX;
    const h = maxY - minY;
    if (!best || w * h < best.width * best.height) {
      const cosBack = Math.cos(edgeAngle);
      const sinBack = Math.sin(edgeAngle);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const center: Point = {
        x: cx * cosBack - cy * sinBack,
        y: cx * sinBack + cy * cosBack,
      };
      best = { center, width: w, height: h, angle: edgeAngle, corners: rectCorners(center, w, h, edgeAngle) };
    }
  }

  if (!best) throw new Error("minAreaRect requires at least 3 points");
  return best;
}

/**
 * PaddleOCR's `unclip`: expand the box outward by offset = area * unclipRatio / perimeter.
 * Upstream this is a generic polygon offset (via Clipper) applied to an arbitrary
 * contour; since we already reduce every blob to a rectangle via minAreaRect, offsetting
 * each side of that rectangle by `offset` is the exact equivalent for a convex rectangle
 * and avoids pulling in a full polygon-clipping library for this one step.
 */
export function unclipRect(rect: RotatedRect, unclipRatio = 1.5): RotatedRect {
  const area = rect.width * rect.height;
  const perimeter = 2 * (rect.width + rect.height);
  const offset = perimeter > 0 ? (area * unclipRatio) / perimeter : 0;
  const width = rect.width + 2 * offset;
  const height = rect.height + 2 * offset;
  return { ...rect, width, height, corners: rectCorners(rect.center, width, height, rect.angle) };
}

/** Orders 4 arbitrary corner points as [topLeft, topRight, bottomRight, bottomLeft]. */
export function orderQuadPoints(pts: Point[]): [Point, Point, Point, Point] {
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.y - p.x);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.min(...diffs))];
  const bl = pts[diffs.indexOf(Math.max(...diffs))];
  return [tl, tr, br, bl];
}
