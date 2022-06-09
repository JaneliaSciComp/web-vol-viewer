import * as THREE from 'three';

/* eslint-disable import/prefer-default-export */

export function makeFluoTransferTex(alpha0, peak, dataGamma, alpha1, colorStr)
{
  // See Wan et al., 2012, "FluoRender: An Application of 2D Image Space Methods for
  // 3D and 4D Confocal Microscopy Data Visualization in Neurobiology Research"
  // https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3622106/

  const color = new THREE.Color(colorStr).multiplyScalar(255);
  const width = 256;
  const height = 1;
  const size = width * height;
  const data = new Uint8Array(4 * size);
  for (let i = 0; i < width; i += 1) {
    // Compute the alpha for the data value at `i` in three steps. For the first step, 
    // think of a triangular "tent" with `y = 0` at `x = 0`, `y = 1` at `x = peak`, and 
    // `y = 0` at `x = 255`, and find the `y` on this tent at `x = i`.
    // The slope of the appropriate side of the "tent" is `1.0 / d`.
    const d = (i < peak) ? peak : width - peak - 1;
    const x = (i < peak) ? i : width - i - 1;
    const y = (1.0 / d) * x;

    // For the second step, use an exponential of `dataGamma` to make the straight "tent" line 
    // "droop" or "bulge".
    const yGamma = y ** (1.0 / dataGamma);

    // For the third step, apply a similar "droop"/"bulge" to a "tent" with `y = alpha0`
    // at `x = 0` and `y = 255` at `x = peak` and `y = alpha1` at `x = 255`.
    let alpha = (i < peak) ? alpha0 : alpha1;
    alpha += yGamma * (255 - alpha);
    alpha = Math.round(alpha);
    alpha = Math.max(0, Math.min(alpha, 255));

    // Match VVD_Viewer, which has an extra factor of alpha in the colors (but not alphas) of
    // its transfer function.
    const extraAlpha = alpha / 255.0;
    data[4 * i]     = color.r * extraAlpha;
    data[4 * i + 1] = color.g * extraAlpha;
    data[4 * i + 2] = color.b * extraAlpha;
    data[4 * i + 3] = alpha;
  }

  const transferTexture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat); 
  transferTexture.wrapS = THREE.ClampToEdgeWrapping;
  transferTexture.wrapT = THREE.ClampToEdgeWrapping;
  transferTexture.needsUpdate = true;

  return transferTexture;
}
