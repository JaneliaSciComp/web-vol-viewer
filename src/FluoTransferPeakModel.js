// Image processing and ONNX inference for predicting the optimal `peak`
// parameter (saturation point) of the fluorescence transfer function.
// Used by `FluoTransferPeakPredictor.js`.
//
// Pipeline:
//   1. Extract a green mask from a surface-only render.
//   2. Distance-transform the green mask, thresholded at two radii:
//        - larger radius for the crop-region mask (drives bounding box)
//        - smaller radius for the green-surface mask (tensor channel 0)
//   3. Compute a square bounding box from the crop mask.
//   4. Crop the R channel from each combined render and the two masks,
//      then resize each to `config.image_size`.
//   5. Assemble a (`num_channels` x `image_size` x `image_size`) float32 tensor.
//   6. Run ONNX inference to predict the optimal `peak` value.


import config from './peakModelConfig.json';
// eslint-disable-next-line import/extensions, import/no-unresolved
import defaultModelUrl from './peakModelData.js';

// `onnxruntime-web` is an optional peer dependency so that consumers not using
// the peak predictor do not pay for the additional bundle weight.  It is loaded
// via dynamic `import()` on the first predictor call.  If the consuming
// application has not installed it, the rejection handler throws an error that
// names the package and version range.
let ortPromise = null;
function getOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then(
      (mod) => {
        const ort = mod.default || mod;
        // Pin the WASM CDN URL to the version of the installed JS SDK so a
        // future mismatch of SDK and WASM versions cannot silently break inference.
        const ortVersion = ort.env.versions.web;
        ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/`;
        console.log('ort version:', ortVersion, 'wasmPaths:', ort.env.wasm.wasmPaths);
        return ort;
      },
      (err) => {
        throw new Error(
          'usePeakPredictor requires onnxruntime-web as an optional peer dependency. ' +
          'Install it in the consuming app: `npm install onnxruntime-web@^1.24.3`. ' +
          `(underlying error: ${err && err.message ? err.message : err})`
        );
      }
    );
  }
  return ortPromise;
}

// The tensor has 2 mask channels plus one per peak.  A mismatch here would
// silently misalign the tensor with what the model was trained on.
const expectedNumChannels = 2 + config.peaks.length;
console.assert(
  config.num_channels === expectedNumChannels,
  `PeakInference: num_channels (${config.num_channels}) must equal ${expectedNumChannels}`
);

// -------------------------------------------------------------------
// ONNX model loading (cached across calibrations)
// -------------------------------------------------------------------

let modelPromise = null;

// Load the ONNX model.  Concurrent callers share the same `Promise`.
// Returns a `Promise` that resolves to an `ort.InferenceSession`.
export function loadModel(modelUrl = defaultModelUrl) {
  if (!modelPromise) {
    modelPromise = getOrt().then((ort) =>
      ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      })
    );
  }
  return modelPromise;
}

// -------------------------------------------------------------------
// Green mask extraction
// -------------------------------------------------------------------

// Extract a binary mask of green pixels from a surface-only render.
// The `pixels` array uses bottom-row-first (GL) order; the returned
// `Uint8Array` mask uses top-row-first (standard image) order, with 1 for
// green and 0 otherwise.
export function extractGreenMask(pixels, width, height) {
  const greenThresh = config.green_mask_thresholds.green_thresh;
  const redMax = config.green_mask_thresholds.red_max;
  const blueMax = config.green_mask_thresholds.blue_max;
  const n = width * height;
  const mask = new Uint8Array(n);

  for (let y = 0; y < height; y += 1) {
    const glRow = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const srcIdx = (glRow * width + x) * 4;
      const r = pixels[srcIdx];
      const g = pixels[srcIdx + 1];
      const b = pixels[srcIdx + 2];
      const dstIdx = y * width + x;
      mask[dstIdx] = g > greenThresh && r < redMax && b < blueMax ? 1 : 0;
    }
  }
  return mask;
}

// -------------------------------------------------------------------
// Distance transform and dilation
// -------------------------------------------------------------------

// Two-pass Manhattan distance transform of a binary mask, O(W*H).  Returns an
// `Int32Array` of raw distances so a single transform can be thresholded at
// multiple radii.
export function distanceTransform(mask, width, height) {
  const INF = width + height;
  const dist = new Int32Array(mask.length);

  for (let i = 0; i < mask.length; i += 1) {
    dist[i] = mask[i] ? 0 : INF;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (x > 0) {
        dist[idx] = Math.min(dist[idx], dist[idx - 1] + 1);
      }
      if (y > 0) {
        dist[idx] = Math.min(dist[idx], dist[idx - width] + 1);
      }
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const idx = y * width + x;
      if (x < width - 1) {
        dist[idx] = Math.min(dist[idx], dist[idx + 1] + 1);
      }
      if (y < height - 1) {
        dist[idx] = Math.min(dist[idx], dist[idx + width] + 1);
      }
    }
  }

  return dist;
}

// Threshold a distance transform into a binary `Uint8Array` mask at radius `n`.
export function thresholdDist(dist, n) {
  const result = new Uint8Array(dist.length);
  for (let i = 0; i < dist.length; i += 1) {
    result[i] = dist[i] <= n ? 1 : 0;
  }
  return result;
}

// -------------------------------------------------------------------
// Bounding box
// -------------------------------------------------------------------

// Compute a padded, square crop region from a binary mask.  Returns an object
// `{ y0, x0, size }` describing the crop square, or `null` if the mask is empty.
export function computeBBox(mask, width, height) {
  const padFraction = config.bbox_pad_fraction;

  let xMin = width;
  let xMax = 0;
  let yMin = height;
  let yMax = 0;
  let found = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        xMin = Math.min(x, xMin);
        xMax = Math.max(x, xMax);
        yMin = Math.min(y, yMin);
        yMax = Math.max(y, yMax);
        found = true;
      }
    }
  }

  if (!found) {
    return null;
  }

  const h = yMax - yMin + 1;
  const w = xMax - xMin + 1;
  const pad = Math.floor(Math.max(h, w) * padFraction);
  yMin = Math.max(0, yMin - pad);
  xMin = Math.max(0, xMin - pad);
  yMax = Math.min(height - 1, yMax + pad);
  xMax = Math.min(width - 1, xMax + pad);

  let size = Math.max(yMax - yMin + 1, xMax - xMin + 1);

  const cy = Math.floor((yMin + yMax) / 2);
  const cx = Math.floor((xMin + xMax) / 2);
  let y0 = cy - Math.floor(size / 2);
  let x0 = cx - Math.floor(size / 2);

  if (y0 < 0) {
    y0 = 0;
  }
  if (x0 < 0) {
    x0 = 0;
  }
  if (y0 + size > height) {
    y0 = height - size;
  }
  if (x0 + size > width) {
    x0 = width - size;
  }
  y0 = Math.max(0, y0);
  x0 = Math.max(0, x0);
  size = Math.min(size, height - y0, width - x0);

  return { y0, x0, size };
}

// ------------------------------------------------------------------------------------
// Crop region + dual-threshold dilation (one DT, two thresholds)
// ------------------------------------------------------------------------------------

// Compute the crop region, crop scale, and both masks from a surface-only
// render.  A single distance transform is thresholded at two radii to produce
// the green-surface mask and the crop-region mask.  Returns an object with
// `cropRegion`, `cropScale`, `greenMask`, and `cropMask`.
export function computeCropRegion(surfaceData) {
  const { pixels, width, height } = surfaceData;

  const greenMask = extractGreenMask(pixels, width, height);
  const dist = distanceTransform(greenMask, width, height);

  // Scale dilation radii to match the training render resolution (1024 x 1024).
  const renderSize = Math.max(width, height);
  const scaledDilationN = Math.round((config.dilation_n * renderSize) / 1024);
  const scaledGreenDilationN = Math.round(
    (config.green_dilation_n * renderSize) / 1024
  );

  const cropMask = thresholdDist(dist, scaledDilationN);
  const greenDilated = thresholdDist(dist, scaledGreenDilationN);
  const bbox = computeBBox(cropMask, width, height);

  if (!bbox) {
    const size = Math.min(width, height);
    return {
      cropRegion: { y0: 0, x0: 0, size },
      cropScale: 1.0,
      greenMask: greenDilated,
      cropMask,
    };
  }

  const fullSize = Math.max(width, height);
  return {
    cropRegion: bbox,
    cropScale: bbox.size / fullSize,
    greenMask: greenDilated,
    cropMask,
  };
}

// --------------------------------------------------------------------------------------
// Crop + resize (shared core, cached canvases and `ImageData`)
// --------------------------------------------------------------------------------------

// Canvases, contexts, and `ImageData` are reused across calls to avoid
// per-peak allocation churn.  The `willReadFrequently: true` option forces a
// software-backed canvas so that `getImageData` is a memory copy rather than a
// GPU-to-CPU transfer.  This option must be passed on the first
// `getContext('2d')` call for a given canvas.
const cache = {
  cropCanvas: null,
  cropCtx: null,
  resizeCanvas: null,
  resizeCtx: null,
  imageData: null,
};

function ensureCrop(size) {
  if (!cache.cropCanvas) {
    cache.cropCanvas = document.createElement('canvas');
    cache.cropCtx = cache.cropCanvas.getContext('2d', {
      willReadFrequently: true,
    });
  }
  if (cache.cropCanvas.width !== size) {
    cache.cropCanvas.width = size;
    cache.cropCanvas.height = size;
  }
}

function ensureResize(size) {
  if (!cache.resizeCanvas) {
    cache.resizeCanvas = document.createElement('canvas');
    cache.resizeCtx = cache.resizeCanvas.getContext('2d', {
      willReadFrequently: true,
    });
  }
  if (cache.resizeCanvas.width !== size) {
    cache.resizeCanvas.width = size;
    cache.resizeCanvas.height = size;
  }
}

function getImageDataForCrop(size) {
  if (!cache.imageData || cache.imageData.width !== size) {
    cache.imageData = new ImageData(size, size);
  }
  return cache.imageData;
}

// Crop a region via the `readByte(srcY, srcX)` callback, write it into a
// cached `ImageData` as grayscale, then resize to `targetSize` using the
// cached resize canvas.  When `smoothing` is true the resize uses bilinear
// interpolation; when false it uses nearest-neighbor (to preserve binary
// masks).  Returns a `Uint8ClampedArray` of RGBA pixel data.
function cropAndResize(readByte, crop, targetSize, smoothing) {
  const { y0, x0, size } = crop;

  ensureCrop(size);
  const imageData = getImageDataForCrop(size);
  const { data } = imageData;

  for (let cy = 0; cy < size; cy += 1) {
    for (let cx = 0; cx < size; cx += 1) {
      const val = readByte(y0 + cy, x0 + cx);
      const i = (cy * size + cx) * 4;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
  }
  cache.cropCtx.putImageData(imageData, 0, 0);

  ensureResize(targetSize);
  cache.resizeCtx.imageSmoothingEnabled = smoothing;
  if (smoothing) {
    cache.resizeCtx.imageSmoothingQuality = 'high';
  }
  cache.resizeCtx.drawImage(cache.cropCanvas, 0, 0, targetSize, targetSize);

  return cache.resizeCtx.getImageData(0, 0, targetSize, targetSize).data;
}

// Crop a single color channel from RGBA `pixels` (bottom-row-first, GL order)
// and resize to a `targetSize` x `targetSize` square.  Returns a `Float32Array`
// with values in [0, 1].
export function cropResizeChannel(
  pixels,
  width,
  height,
  channelIndex,
  crop,
  targetSize
) {
  const readByte = (srcY, srcX) => {
    const glRow = height - 1 - srcY;
    return pixels[(glRow * width + srcX) * 4 + channelIndex];
  };
  const data = cropAndResize(readByte, crop, targetSize, true);

  const result = new Float32Array(targetSize * targetSize);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = data[i * 4] / 255;
  }
  return result;
}

// Crop a binary mask (top-row-first) and resize to a square using
// nearest-neighbor interpolation so the output stays binary.  Returns a
// `Float32Array` with values 0.0 or 1.0.
export function cropResizeMask(mask, width, height, crop, targetSize) {
  const readByte = (srcY, srcX) => (mask[srcY * width + srcX] ? 255 : 0);
  const data = cropAndResize(readByte, crop, targetSize, false);

  const result = new Float32Array(targetSize * targetSize);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = data[i * 4] > 128 ? 1 : 0;
  }
  return result;
}

// -------------------------------------------------------------------
// Tensor assembly
// -------------------------------------------------------------------

// Build the (`numChannels` x `imageSize` x `imageSize`) float32 tensor for
// ONNX inference.  Returns a `Float32Array`.
//
// Channel 0:       dilated green mask (binary, surface location)
// Channel 1:       crop region mask   (binary)
// Channels 2..N+1: magenta R channel from each combined render,
//                  in low-to-high peak order
export function buildTensor(
  combinedFrames,
  cropRegion,
  greenMask,
  cropMask,
  maskWidth,
  maskHeight
) {
  const imageSize = config.image_size;
  const numChannels = config.num_channels;
  const hw = imageSize * imageSize;
  const tensor = new Float32Array(numChannels * hw);

  // Channel 0: dilated green mask.
  tensor.set(
    cropResizeMask(greenMask, maskWidth, maskHeight, cropRegion, imageSize),
    0
  );

  // Channel 1: crop region mask.
  tensor.set(
    cropResizeMask(cropMask, maskWidth, maskHeight, cropRegion, imageSize),
    1 * hw
  );

  // Channels 2..N+1: magenta R channel from each combined render.
  for (let i = 0; i < combinedFrames.length; i += 1) {
    const frame = combinedFrames[i];
    tensor.set(
      cropResizeChannel(
        frame.pixels,
        frame.width,
        frame.height,
        0, // R
        cropRegion,
        imageSize
      ),
      (i + 2) * hw
    );
  }

  return tensor;
}

// -------------------------------------------------------------------
// ONNX inference
// -------------------------------------------------------------------

// Run ONNX inference to predict the optimal `peak`.  Returns a `Promise` that
// resolves to a raw float; the caller is responsible for rounding and clamping.
export async function runInference(session, tensor, cropScale) {
  const ort = await getOrt();
  const imageSize = config.image_size;
  const numChannels = config.num_channels;

  const imageTensor = new ort.Tensor('float32', tensor, [
    1,
    numChannels,
    imageSize,
    imageSize,
  ]);

  const scaleTensor = new ort.Tensor('float32', new Float32Array([cropScale]), [
    1,
  ]);

  const results = await session.run({
    image: imageTensor,
    crop_scale: scaleTensor,
  });

  return results.peak.data[0];
}
