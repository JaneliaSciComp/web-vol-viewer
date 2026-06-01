// The React hook `usePeakPredictor` defined here sets up prediction of a
// good peak value to use in a transfer function that highlights the match
// between a volume and a surface.
//
// The final value returned by `usePeakPredictor` is `predictFluoTransferPeak`,
// an async function that runs the prediction. It has three phases: 
// 1. capture a surface-only frame to be used to define some masks;
// 2, capture a frame for each of a set of sample peak values that are input to
//    a neural network;
// 3. run inference using an ONNX version of the network with the masks and the
//    rendered frames as inputs.
// Each phase calls `captureFrameForPeak`, which sets up a one-shot `Promise`
// resolved the next time `onRenderedImage` fires, then calls `setTransferFunctionTexPredicting`
// to trigger a render with the appropriate transfer function.
//
// Frames are rendered in order from high peak to low peak so the visual feedback
// fades from dark to bright.  The captured frames are reversed before `buildTensor`
// because the model was trained on low-to-high order.
//
// A monotonically increasing `runIdRef` invalidates any in-flight prediction
// when `predictFluoTransferPeak` is called again or the component unmounts.

import { useState, useRef, useCallback, useEffect } from 'react';
import { makeFluoTransferTex } from './TransferFunctions';
import {
  loadModel,
  computeCropRegion,
  buildTensor,
  runInference,
} from './FluoTransferPeakModel';
import config from './peakModelConfig.json';

// Fallback `peak` if inference fails.
const PEAK_FALLBACK = 50;

// When true, each transfer texture carries a watermark (the `peak` value) that
// the shader writes into the blue channel of the center pixel.  The captured
// frame is checked against this value before being accepted.  A mismatch aborts
// the prediction.  When false, no watermark is attached and no check is
// performed.
const VERIFY_WATERMARK = true;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

// Round and clamp a raw inference output to a valid integer `peak` value.
function clampPeak(rawPeak) {
  return Math.round(
    Math.max(config.peak_min, Math.min(config.peak_max, rawPeak))
  );
}

// Read the watermark byte at the image center.  The shader writes it to the
// B channel (offset 2), which is not used by the tensor.  Returns a single
// integer in the range 0 to 255.
function readWatermarkAtCenter(frame) {
  const cx = Math.floor(frame.width / 2);
  const cy = Math.floor(frame.height / 2);
  return frame.pixels[(cy * frame.width + cx) * 4 + 2];
}

// Race a promise against a timeout.  Rejects with `errorMsg` if the timeout
// fires first.  The `clearTimeout` in `finally` prevents the timer from
// firing after the race has already resolved.
function withTimeout(promise, ms, errorMsg) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
} 

// -------------------------------------------------------------------------
// Main React hook
// 
// Sets up prediction of a `peak` value for the fluorescence transfer function.
// Returns reactive state that updates as prediction progresses:
// `predictFluoTransferPeak`: function the client calls to start prediction
// `predictedPeak`: `null` until inference completes, then the predicted
//  integer `peak` value
// `isPredicting`: true while prediction is in progress
// `transferFunctionTexPredicting`: client must pass this as the
//  `transferFunctionTex` prop of `Vol3dViewer` while `isPredicting` is true
// `useSurfacePredicting`: client must pass this as the `useSurface` prop of
//  `Vol3dViewer` while `isPredicting` is true
// `onRenderedImagePredicting`: client must pass this as the `onRenderedImage`
//  prop of `Vol3dViewer` while `isPredicting` is true
// -------------------------------------------------------------------------
export default function usePeakPredictor({
  // Lowest and highest possible alphas in the transfer function.
  alpha0,
  alpha1,
  // Gamma (exponent) used in the falloff from the peak value.
  dataGamma,
  // Base color for the display of data with this transfer fucntion.
  colorStr
}) {
  // The transfer texture the consumer should render with while prediction is
  // in progress.  When `null`, the consumer renders with its own texture.
  const [transferFunctionTexPredicting, setTransferFunctionTexPredicting] = useState(null);
  const [predictedPeak, setPredictedPeak] = useState(null);

  // Dispose each transfer texture when it is replaced or the component
  // unmounts, to release its GPU resources.
  useEffect(() => () => {
    if (transferFunctionTexPredicting) {
      transferFunctionTexPredicting.dispose();
    }
  }, [transferFunctionTexPredicting]);

  // Receives the next captured frame during prediction.
  const pendingFrameRef = useRef(null);

  // The watermark value expected in the next captured frame.
  const expectedWatermarkRef = useRef(null);

  // Monotonic run ID for invalidation of in-flight predictions.
  const runIdRef = useRef(0);

  // Invalidate any in-flight prediction on unmount.
  useEffect(
    () => () => {
      runIdRef.current += 1;
    },
    []
  );

  // Note we are in a React hook which will get called with each component update
  // so values like this one will get updated.
  const isPredicting = transferFunctionTexPredicting !== null;

  // -----------------------------------------------------------------
  // `Vol3dViewer.onRenderedImage` callback
  // -----------------------------------------------------------------

  const onRenderedImagePredicting = useCallback((frame) => {
    const pending = pendingFrameRef.current;
    if (!pending) {
      return;
    }
    pendingFrameRef.current = null;

    if (VERIFY_WATERMARK) {
      const expected = expectedWatermarkRef.current;
      const actual = readWatermarkAtCenter(frame);
      if (actual !== expected) {
        const msg = `watermark mismatch: expected ${expected}, got ${actual} at image center`;
        console.error(msg);
        pending.reject(new Error(msg));
        return;
      }
      console.log(`watermark ${actual} matched expected ${expected}`);
    }

    pending.resolve(frame);
  }, []);

  // ------------------------------------------------------------------------------
  // Orchestrator. Functions for each of the three phases are nested inside so they
  // close over fresh prop values without appearing in the `useCallback` deps.
  // ------------------------------------------------------------------------------

  const predictFluoTransferPeak = useCallback(async () => {
    // Begin a new run, invalidating any previous run in flight.
    runIdRef.current += 1;
    const runId = runIdRef.current;
    const live = () => runId === runIdRef.current;

    // Capture protocol

    // `captureFrameForPeak` creates a `Promise.` Before it returns that `Promise,`
    // it stores the `Promise` `resolve` and `reject` functions, and uses
    // `setTransferFunctionTexPredicting` to set the transfer function texture
    // to use a particular peak. That state change causes `Vol3dViewer` to
    // re-render with the new peak, and call `onRenderedImagePredicting` with
    // the rendered pixels. `onRenderedImagePredicting` retrieves the stored
    // `resolve` function and calls it with the rendered pixels as the argument.
    // Since `captureFrameForPeak` also returns that `Promise`, the code awaiting
    // it receives those pixels as the resolved value.

    // Set up the `Promise` for the next `Vol3dViewer.onRenderedImage` callback.
    const captureNext = () =>
      new Promise((resolve, reject) => {
        // `onRenderedImagePredicting` will call `reject` only if the watermark does not match.
        pendingFrameRef.current = { resolve, reject };
      });

    // Set the expected watermark, prepare the capture `Promise`, then call
    // `setTransferFunctionTexPredicting` to trigger a render at the given `peak` and `gamma`.
    const captureFrameForPeak = (peak, gammaForPeak) => {
      expectedWatermarkRef.current = peak;
      const framePromise = captureNext();
      setTransferFunctionTexPredicting(
        makeFluoTransferTex(
          alpha0,
          peak,
          gammaForPeak,
          alpha1,
          colorStr,
          VERIFY_WATERMARK ? peak : undefined
        )
      );
      return framePromise;
    };

    // Prediction phases

    // Phase 1: capture a surface-only frame (`peak` = 255, `dataGamma` = 0
    // makes the volume invisible so only the green surface is visible).
    const captureSurfaceFrame = async () => {
      const frame = await captureFrameForPeak(255, 0);
      if (!live()) {
        return null;
      }
      console.timeLog('predict-peak-renders', 'surface captured');
      return frame;
    };

    // Phase 2: capture combined frames, rendered high-to-low peak.
    const captureCombinedFrames = async () => {
      const frames = [];
      for (let i = config.peaks.length - 1; i >= 0; i -= 1) {
        const peak = config.peaks[i];
        // Explicitly pass in the real `dataGamma` because `captureFrameForPeak` is also
        // used with a temporary data gamma of 0 to hide the volume for surface-only
        // rendering.
        // eslint-disable-next-line no-await-in-loop
        const frame = await captureFrameForPeak(peak, dataGamma);
        if (!live()) {
          return null;
        }
        frames.push(frame);
      }
      return frames;
    };

    // Phase 3: run inference on the captured frames.
    const predictPeakFromFrames = async (
      surfaceFrame,
      combinedFrames,
      modelPromise
    ) => {
      console.time('predict-peak-inference');

      console.time('peak-model-load');
      const model = await withTimeout(
        modelPromise,
        10000,
        'ONNX model load timed out after 10 seconds (likely a CDN or network issue)' 
      );
      console.timeEnd('peak-model-load');
      if (!live()) {
        return null;
      }

      console.time('peak-crop');
      const { cropRegion, cropScale, greenMask, cropMask } =
        computeCropRegion(surfaceFrame);
      console.timeEnd('peak-crop');

      console.time('peak-tensor');
      // Reverse to match training order (low-to-high peak).
      const tensor = buildTensor(
        combinedFrames.slice().reverse(),
        cropRegion,
        greenMask,
        cropMask,
        surfaceFrame.width,
        surfaceFrame.height
      );
      console.timeEnd('peak-tensor');

      console.time('peak-onnx-run');
      const rawPeak = await runInference(model, tensor, cropScale);
      console.timeEnd('peak-onnx-run');
      if (!live()) {
        return null;
      }

      const clampedPeak = clampPeak(rawPeak);
      console.timeEnd('predict-peak-inference');
      console.log(
        `peak prediction complete: predicted = ${clampedPeak} ` +
          `(raw = ${rawPeak.toFixed(1)})`
      );
      return clampedPeak;
    };

    // Run the three phases

    console.time('predict-peak-total');
    console.time('predict-peak-renders');

    setPredictedPeak(null);
    pendingFrameRef.current = null;

    // Load the ONNX model in parallel with the first few renders.
    const modelPromise = loadModel();

    try {
      const surfaceFrame = await captureSurfaceFrame();
      if (!live()) {
        return;
      }

      const combinedFrames = await captureCombinedFrames();
      if (!live()) {
        return;
      }
      console.timeEnd('predict-peak-renders');

      const peak = await predictPeakFromFrames(
        surfaceFrame,
        combinedFrames,
        modelPromise
      );
      if (!live()) {
        return;
      }

      console.timeEnd('predict-peak-total');
      setPredictedPeak(peak);
    } catch (err) {
      console.error('Peak prediction failed:', err);
      if (live()) {
        setPredictedPeak(PEAK_FALLBACK);
      }
    } finally {
      pendingFrameRef.current = null;
      expectedWatermarkRef.current = null;
      // Delay clearing `transferFunctionTexPredicting` so the consumer's effect on
      // `predictedPeak` can update its own `peak` state before `isPredicting` becomes
      // false.
      requestAnimationFrame(() => {
        if (live()) {
          setTransferFunctionTexPredicting(null);
        }
      });
    }
  }, [alpha0, alpha1, dataGamma, colorStr]);

  return {
    isPredicting,
    predictedPeak,
    transferFunctionTexPredicting,
    useSurfacePredicting: isPredicting,
    onRenderedImagePredicting: isPredicting ? onRenderedImagePredicting : null,
    predictFluoTransferPeak,
  };
}
