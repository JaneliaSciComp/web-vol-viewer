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
    const d = (i < peak) ? peak : width - peak - 1;
    const x = (i < peak) ? i : width - i - 1;
    const y = (1.0 / d) * x;
    const yGamma = y ** (1.0 / dataGamma);
    let alpha = (i < peak) ? alpha0 : alpha1;
    alpha += yGamma * (255 - alpha);
    alpha = Math.round(alpha);
    alpha = Math.max(0, Math.min(alpha, 255));

   const preMultAlpha = alpha / 255.0;
   data[4 * i]     = color.r * preMultAlpha;
   data[4 * i + 1] = color.g * preMultAlpha;
   data[4 * i + 2] = color.b * preMultAlpha;
   data[4 * i + 3] = alpha;
  }

  const transferTexture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat); 
  transferTexture.wrapS = THREE.ClampToEdgeWrapping;
  transferTexture.wrapT = THREE.ClampToEdgeWrapping;
  transferTexture.needsUpdate = true;

  return transferTexture;
}
