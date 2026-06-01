import {
  extractGreenMask,
  distanceTransform,
  thresholdDist,
  computeBBox,
  computeCropRegion,
} from './FluoTransferPeakModel';

// peakModelData.js is a build artifact (base64-encoded ONNX model) that only
// exists in dist/. Mock it so Jest can import FluoTransferPeakModel from src/.
jest.mock('./peakModelData.js', () => 'data:application/octet-stream;base64,AA==', { virtual: true });

// Helper: build an RGBA pixel buffer (bottom-row-first, GL convention).
// `pixelFn(x, y)` returns [r, g, b, a] for each pixel in standard
// image coordinates (top-row-first); this helper flips to GL order.
function makeRGBA(width, height, pixelFn) {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const glRow = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelFn(x, y);
      const i = (glRow * width + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

// ---------------------------------------------------------------
// 1. extractGreenMask
// ---------------------------------------------------------------

describe('extractGreenMask', () => {
  it('marks green pixels as 1 and non-green pixels as 0', () => {
    // 4x4 image. Green pixels at (1,0), (2,1), (0,3) in image coords.
    // "Green" means g > 20, r < 50, b < 50 (from config thresholds).
    const w = 4;
    const h = 4;
    const greenPositions = new Set(['1,0', '2,1', '0,3']);

    const pixels = makeRGBA(w, h, (x, y) => {
      if (greenPositions.has(`${x},${y}`)) {
        return [0, 200, 0, 255]; // clearly green
      }
      return [128, 10, 128, 255]; // not green (low G, high R and B)
    });

    const mask = extractGreenMask(pixels, w, h);

    expect(mask.length).toBe(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const expected = greenPositions.has(`${x},${y}`) ? 1 : 0;
        expect(mask[y * w + x]).toBe(expected);
      }
    }
  });

  it('rejects pixels with high red or blue even if green is high', () => {
    const w = 2;
    const h = 1;
    // Pixel 0: high green, high red -> not green mask.
    // Pixel 1: high green, high blue -> not green mask.
    const pixels = makeRGBA(w, h, (x) => {
      if (x === 0) {
        return [200, 200, 0, 255];
      }
      return [0, 200, 200, 255];
    });

    const mask = extractGreenMask(pixels, w, h);
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(0);
  });
});

// ---------------------------------------------------------------
// 2. distanceTransform + thresholdDist
// ---------------------------------------------------------------

describe('distanceTransform and thresholdDist', () => {
  it('computes correct Manhattan distances from a single set pixel', () => {
    // 5x5 mask with a single 1 at center (2,2).
    const w = 5;
    const h = 5;
    const mask = new Uint8Array(w * h);
    mask[2 * w + 2] = 1;

    const dist = distanceTransform(mask, w, h);

    // Manhattan distance from (2,2) to each pixel.
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const expected = Math.abs(x - 2) + Math.abs(y - 2);
        expect(dist[y * w + x]).toBe(expected);
      }
    }
  });

  it('thresholds at radius 1 to produce a diamond shape', () => {
    const w = 5;
    const h = 5;
    const mask = new Uint8Array(w * h);
    mask[2 * w + 2] = 1;

    const dist = distanceTransform(mask, w, h);
    const dilated = thresholdDist(dist, 1);

    // Radius-1 diamond around (2,2): center + 4 neighbors.
    const diamond = new Set(['2,2', '1,2', '3,2', '2,1', '2,3']);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const expectedVal = diamond.has(`${x},${y}`) ? 1 : 0;
        expect(dilated[y * w + x]).toBe(expectedVal);
      }
    }
  });

  it('returns all zeros when the mask is empty', () => {
    const w = 3;
    const h = 3;
    const mask = new Uint8Array(w * h); // all zeros

    const dist = distanceTransform(mask, w, h);
    const dilated = thresholdDist(dist, 5);

    for (let i = 0; i < dilated.length; i += 1) {
      expect(dilated[i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------
// 3. computeBBox
// ---------------------------------------------------------------

describe('computeBBox', () => {
  it('returns null for an empty mask', () => {
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);

    expect(computeBBox(mask, w, h)).toBeNull();
  });

  it('returns a square bounding box centered on a cluster', () => {
    // 20x20 mask with a 4x2 cluster at rows 8-9, cols 6-9.
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h);
    for (let y = 8; y <= 9; y += 1) {
      for (let x = 6; x <= 9; x += 1) {
        mask[y * w + x] = 1;
      }
    }

    const bbox = computeBBox(mask, w, h);

    expect(bbox).not.toBeNull();
    // The result must be square with a positive size.
    expect(bbox.size).toBeGreaterThan(0);
    // size must be at least as large as the cluster's longer side (4).
    expect(bbox.size).toBeGreaterThanOrEqual(4);
    // The box must stay inside the image.
    expect(bbox.x0).toBeGreaterThanOrEqual(0);
    expect(bbox.y0).toBeGreaterThanOrEqual(0);
    expect(bbox.x0 + bbox.size).toBeLessThanOrEqual(w);
    expect(bbox.y0 + bbox.size).toBeLessThanOrEqual(h);
    // The box center should be near the cluster center (7.5, 8.5).
    const bboxCx = bbox.x0 + bbox.size / 2;
    const bboxCy = bbox.y0 + bbox.size / 2;
    expect(Math.abs(bboxCx - 7.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(bboxCy - 8.5)).toBeLessThanOrEqual(1);
  });

  it('clamps to image bounds when the cluster is near an edge', () => {
    // 10x10 mask with a pixel at (0,0).
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);
    mask[0] = 1;

    const bbox = computeBBox(mask, w, h);

    expect(bbox).not.toBeNull();
    expect(bbox.x0).toBeGreaterThanOrEqual(0);
    expect(bbox.y0).toBeGreaterThanOrEqual(0);
    expect(bbox.x0 + bbox.size).toBeLessThanOrEqual(w);
    expect(bbox.y0 + bbox.size).toBeLessThanOrEqual(h);
  });
});

// ---------------------------------------------------------------
// 4. computeCropRegion (end-to-end through pure array code)
// ---------------------------------------------------------------

describe('computeCropRegion', () => {
  it('produces consistent crop region from a green rectangle', () => {
    // 32x32 image with a green filled rectangle at rows 10-20,
    // cols 8-24 (image coords). Everything else is black.
    const w = 32;
    const h = 32;
    const pixels = makeRGBA(w, h, (x, y) => {
      if (x >= 8 && x <= 24 && y >= 10 && y <= 20) {
        return [0, 200, 0, 255];
      }
      return [0, 0, 0, 255];
    });

    const result = computeCropRegion({ pixels, width: w, height: h });

    // cropRegion must be a valid square inside the image.
    const { cropRegion, cropScale, greenMask, cropMask } = result;
    expect(cropRegion.size).toBeGreaterThan(0);
    expect(cropRegion.x0).toBeGreaterThanOrEqual(0);
    expect(cropRegion.y0).toBeGreaterThanOrEqual(0);
    expect(cropRegion.x0 + cropRegion.size).toBeLessThanOrEqual(w);
    expect(cropRegion.y0 + cropRegion.size).toBeLessThanOrEqual(h);

    // cropScale = cropSize / max(width, height).
    expect(cropScale).toBeCloseTo(
      cropRegion.size / Math.max(w, h),
      6
    );

    // Masks must be the same length as the image.
    expect(greenMask.length).toBe(w * h);
    expect(cropMask.length).toBe(w * h);

    // The green mask should have nonzero pixels (the rectangle is
    // clearly green).
    const greenCount = greenMask.reduce((s, v) => s + v, 0);
    expect(greenCount).toBeGreaterThan(0);
  });

  it('falls back gracefully when no green pixels are present', () => {
    // All-black 16x16 image -> no green -> empty mask -> null bbox
    // -> fallback path.
    const w = 16;
    const h = 16;
    const pixels = makeRGBA(w, h, () => [0, 0, 0, 255]);

    const result = computeCropRegion({ pixels, width: w, height: h });

    expect(result.cropRegion.y0).toBe(0);
    expect(result.cropRegion.x0).toBe(0);
    expect(result.cropRegion.size).toBe(Math.min(w, h));
    expect(result.cropScale).toBe(1.0);
  });
});
