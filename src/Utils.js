export function disableSpinnerRepeat(event, previous) {
  // If the change from the previous value...
  const change = Math.abs(event.target.valueAsNumber - previous);

  // ...looks like the "step" amount specified by the spinner
  // (the little up and down arrows)...
  const isStep = (Math.abs(change - event.target.step) < 0.0001);

  if (isStep) {
    // ...then take away focus, so the spinner button works only once.
    // This approach works better than traditional throttling or
    // debouncing, and (mostly) does not affect the direct typing of
    // a numeric value.
    event.target.blur();
  }
}

export function fixVolumeSize(volumeSize, data) {
  const volumeSizeFixed = volumeSize;
  // TODO: Is it really right that in practice, `image_size[2]` on the original file can be wrong?
  const realFrameCount = data.byteLength / (volumeSize[0] * volumeSize[1]);
  if (realFrameCount !== volumeSize[2]) {
    console.log(`Frame count (z) seems to be ${realFrameCount} rather than ${volumeSize[2]}`);
    volumeSizeFixed[2] = realFrameCount;
  }
  return (volumeSizeFixed);
}

export function getBoxSize(volumeSize, voxelSize)
{
  const s = volumeSize[0] * voxelSize[0];
  const boxWidth = 1;
  const boxHeight = volumeSize[1] * voxelSize[1] / s;
  const boxDepth = volumeSize[2] * voxelSize[2] / s;
  const boxSize = [boxWidth, boxHeight, boxDepth];
  return boxSize;
}

export function noInternet(error) {
  return ((error instanceof TypeError) && (error.message === 'Failed to fetch'));
}

// In the result object:
// `voxSize` is the `voxel_size` attribute from the H5J file (HDF5 container)
// `volSize` is the `image_size` attribute
// `chanSpecs` is the `channel_spec` attributes
export function parseH5jAttrs(attrs) {
  let volSize = [0, 0, 0];
  let voxSize = [0, 0, 0];
  if ('image_size' in attrs) {
    volSize = attrs.image_size;
    console.log(`Attribute 'image_size': ${volSize}`);
  }
  if ('voxel_size' in attrs) {
    voxSize = attrs.voxel_size;
    console.log(`Attribute 'voxel_size': ${voxSize}`);
  }
  const { channels: attrsChs } = attrs;
  if ('width' in attrs.channels) {
    const { width: widths } = attrsChs;
    const width = widths[0];
    volSize[0] = width;
  }
  if ('height' in attrs.channels) {
    const { height: heights } = attrsChs;
    const height = heights[0];
    volSize[1] = height;
  }
  if ('frames' in attrs.channels) {
    const { frames: frameses } = attrsChs;
    const frames = frameses[0];
    volSize[2] = frames;
  }
  const alignment = 8;
  volSize[0] = Math.ceil(volSize[0] / alignment) * alignment;
  volSize[1] = Math.ceil(volSize[1] / alignment) * alignment;        
  console.log(`Word aligned volume size: ${volSize}`);

  const chanSpecs = attrs.channels.names.map((name, i) => (
    { name, content: attrs.channels.content_types[i] }
  ));

  return ({ volSize, voxSize, chanSpecs });
}


// Returns the scale and translation needed to align a surface in micron coordinates
// with the volume having the specified volume size (number of voxels per dimension)
// and voxel size (microns per voxel per dimension).
export function surfaceAlignmentFactors(units, volSize, voxelSize) {
  let surfaceScale = 0.00161;
  let surfaceTranslation = [-313.7, -147.5, -86.5];

  if (units === 'micron') {
    const micronSize = volSize.map((e, i) => e * voxelSize[i]);
    const sizeMax = Math.max(...micronSize);
    surfaceScale = (sizeMax > 0) ? 1 / sizeMax : 1;
    surfaceTranslation = micronSize.map(e => -e / 2);
  }

  return ({ surfaceScale, surfaceTranslation })
}

export async function textFromFileOrURL(src) {
  const errPrefix = "textFromFileOrURL failed:";
  
  // Treat a string argument as a URL and use `fetch` to return a promise that 
  // resolves to the text.
  if (typeof src === 'string') {
    return (fetch(src)
      .then((response) => {
        if (response.ok) {
          if (response.status === 200) {
            return response.text();
          }
          throw new Error(`${errPrefix} response.status ${response.status}, "${response.statusText}"`);
        }
        throw new Error(`${errPrefix} response.ok false`);
      })
    )
  }
  // If the argument is a reference to a local text file, read it with `FileReader`
  // but rephrase the reading with promises to match the pattern of `fetch`.
  if (src instanceof File) {
    return (new Promise((resolve, reject) => {
      const reader = new FileReader(); 
      reader.onload = (readerEvent) => {
        try {
          const text = readerEvent.target.result;
          resolve(text);
        } catch (exc) {
          reject(new Error(`${errPrefix} ${exc}`));
        }
      };
      reader.onerror = reject;
      reader.readAsText(src);
    }));
  }
  return Promise.reject(new Error(`${errPrefix} unknown "src" type`));
}
