import type { Point } from "./geometry";

/** Solves the 2D affine transform (as canvas setTransform args) mapping src -> dst for 3 point pairs. */
function solveAffine(
  src: [Point, Point, Point],
  dst: [Point, Point, Point]
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (denom === 0) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
  const c = ((s1.x - s0.x) * (d2.x - d0.x) - (s2.x - s0.x) * (d1.x - d0.x)) / denom;
  const e = d0.x - a * s0.x - c * s0.y;

  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
  const d = ((s1.x - s0.x) * (d2.y - d0.y) - (s2.x - s0.x) * (d1.y - d0.y)) / denom;
  const f = d0.y - b * s0.x - d * s0.y;

  return { a, b, c, d, e, f };
}

/**
 * Crops and straightens a (possibly rotated) quadrilateral region of `source` into a
 * new outWidth x outHeight canvas. Splits the quad into two triangles and maps each
 * with its own affine transform (a standard technique for quad-to-rect warps on a 2D
 * canvas context, which has no native arbitrary-quad `drawImage`).
 */
export function cropQuadToCanvas(
  source: HTMLCanvasElement,
  corners: [Point, Point, Point, Point], // [topLeft, topRight, bottomRight, bottomLeft], source coords
  outWidth: number,
  outHeight: number
): HTMLCanvasElement {
  const [tl, tr, br, bl] = corners;
  const dst = {
    tl: { x: 0, y: 0 },
    tr: { x: outWidth, y: 0 },
    br: { x: outWidth, y: outHeight },
    bl: { x: 0, y: outHeight },
  };

  const out = document.createElement("canvas");
  out.width = outWidth;
  out.height = outHeight;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  const triangles: [Point, Point, Point, Point, Point, Point][] = [
    [tl, tr, bl, dst.tl, dst.tr, dst.bl],
    [tr, br, bl, dst.tr, dst.br, dst.bl],
  ];

  for (const [s0, s1, s2, d0, d1, d2] of triangles) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.lineTo(d2.x, d2.y);
    ctx.closePath();
    ctx.clip();
    const { a, b, c, d, e, f } = solveAffine([s0, s1, s2], [d0, d1, d2]);
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  return out;
}
