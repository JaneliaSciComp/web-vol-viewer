// Adds simple user interface controls to `Vol3dViewer`.  The controls use
// basic HTML and CSS, so a real application might replace this component
// with something similar using a real toolkit like Material UI or Ant Design.

import React from 'react';
import './H5j3dViewerWithBasicUI.css';

import { createFFmpegForEnv, getH5JAttrs, openH5J, readH5JChannelUint8 } from '@janelia/web-h5j-loader';
import { makeFluoTransferTex } from './TransferFunctions';
import Vol3dViewer from './Vol3dViewer';
import { makeSwcSurface, parseSwc } from './Swc';
import { fixVolumeSize, parseH5jAttrs, surfaceAlignmentFactors, textFromFileOrURL } from './Utils';
import FileOrURLInput from './FileOrURLInput';

function H5j3dViewerWithBasicUI() {
  const alpha0 = 0;
  const peakDefault = 217;
  const dataGammaDefault = 0.5;
  const alpha1 = 255;

  const [fileH5J, setFileH5J] = React.useState(null);
  const [filename, setFilename] = React.useState(null);
  const [volumeSize, setVolumeSize] = React.useState(null);
  const [voxelSize, setVoxelSize] = React.useState(null);
  const [units, setUnits] = React.useState('');
  const [channelSpecs, setChannelSpecs] = React.useState(null);
  const [channel, setChannel] = React.useState(null);
  const [loadingPercent, setLoadingPercent] = React.useState(0);
  const [ffmpegWasm, setFfmpegWasm] = React.useState(null);
  const [loadingError, setLoadingError] = React.useState(null);
  const [dataUint8, setDataUint8] = React.useState(null);
  const [useLighting, setUseLighting] = React.useState(true);
  const [dataColor, setDataColor] = React.useState('#ff00ff');
  const [dtScale, setDtScale] = React.useState(Vol3dViewer.defaultProps.dtScale);
  const [interactionSpeedup, setInteractionSpeedup] = React.useState(1);
  const [peak, setPeak] = React.useState(peakDefault);
  const [dataGamma, setDataGamma] = React.useState(dataGammaDefault);
  const [finalGamma, setFinalGamma] = React.useState(Vol3dViewer.defaultProps.finalGamma);
  const [useSurface, setUseSurface] = React.useState(false);
  const [swcSurfaceMesh, setSwcSurfaceMesh] = React.useState(null);
  const [surfaceColor, setSurfaceColor] = React.useState('#00ff00');

  // Not `React.useState` so changes do not cause React to re-render.
  const allowThrottledEvent = React.useRef(false);

  const transferFunctionTexRef = React.useRef(makeFluoTransferTex(alpha0, peak, dataGamma, alpha1, dataColor));

  const onDataFileInputChange = async (event) => {
    let src = null;
    if (event.target.files && (event.target.files.length > 0)) {
      // Local file
      const f = event.target.files[0];
      setFilename(f.name);
      src = f;
    } else if (event.target.value && (typeof event.target.value === 'string')) {
      // URL
      setFilename(event.target.value);
      src = event.target.value;
    }
    if (src) {
      setLoadingError(null);
      setChannelSpecs(null);
      try {
        // The key code for loading the H5J file as an HDF5 container; similar code would be needed
        // to use the `Vol3dViewer` component with another user interface.  This part of the code
        // opens the container and gets the channel information, so the user can pick a channel
        // with the H.265 encoded volume data to load in `onLoadChannel`.

        const fH5J = await openH5J(src);
        const attrs = getH5JAttrs(fH5J);

        const { volSize, voxSize, chanSpecs } = parseH5jAttrs(attrs);
        setFileH5J(fH5J);
        setVolumeSize(volSize);
        setVoxelSize(voxSize);
        setUnits(attrs.unit);
        setChannelSpecs(chanSpecs);

        // When loading a dataset after the first time, this state resetting causes the
        // intermediate user interface to appear properly.
        setChannel(null);
        setLoadingPercent(0);
        setDataUint8(null);
      } catch (exc) {
        setLoadingError(exc);
      }
    }
  }

  const onLoadChannel = async () => {
    const radios = document.getElementsByName("channels-radio-group");
    if (radios) {
      let checked
      for (let i = 0; i < radios.length; i += 1) {
        if (radios[i].checked) {
           checked = radios[i];
        }
      }
      if (checked) {
        const ch = checked.value;
        console.log(`Loading 'Channels/${ch}'`);

        setChannel(ch);
        const onProgress = ({ ratio }) => {
          setLoadingPercent(Math.round(ratio * 100));
        };

        // The key code for loading the H.265 encoded volume data from one channel of the HDF5 container; 
        // similar code would be needed to use the `Vol3dViewer` component with another user interface.

        // Reuse the results of initializing ffpmeg.wasm once.  Doing so seems to save about a second
        // on any file reading after the first reading.
        let ff = ffmpegWasm;
        if (!ff) {
          ff = await createFFmpegForEnv();
          setFfmpegWasm(ff);
        }

        const data = await readH5JChannelUint8(ch, fileH5J, onProgress, ff);

        if (data) {
          console.log(`Loaded ${data.byteLength} bytes`);

          setVolumeSize(fixVolumeSize(volumeSize, data));

          // Treat the `ArrayBuffer` as an array of unsigned 8-bit integers.  Doing so should not
          // copy the underlying data, and is necessary to make the `THREE.DataTexture3D`.
          const dUint8 = new Uint8Array(data.buffer);
          console.log(`Converted ${dUint8.length} bytes`);
          setDataUint8(dUint8);

          setDtScale(Vol3dViewer.defaultProps.dtScale);
          setPeak(peakDefault);
          setDataGamma(dataGammaDefault);
          setFinalGamma(Vol3dViewer.defaultProps.finalGamma);
        }
      }
    }
  }

  const onSurfaceFileInputChange = async (event) => {
    let src = null;
    if (event.target.files && (event.target.files.length > 0)) {
      // Local file
      const f = event.target.files[0];
      src = f;
    } else if (event.target.value && (typeof event.target.value === 'string')) {
      // URL
      src = event.target.value;
    }
    if (src) {
      setLoadingError(null);
      try {
        const text = await textFromFileOrURL(src);
        const json = parseSwc(text);
        const mesh = makeSwcSurface(json, surfaceColor);

        const { surfaceScale, surfaceTranslation } = surfaceAlignmentFactors(units, volumeSize, voxelSize);

        mesh.scale.set(surfaceScale, surfaceScale, surfaceScale);
        mesh.position.set(surfaceTranslation[0] * surfaceScale,
          surfaceTranslation[1] * surfaceScale, surfaceTranslation[2] * surfaceScale);

        setSwcSurfaceMesh(mesh);
        setUseSurface(true);

        // Relinquish keyboard focus, so pressing a key to toggle the surface visibility,
        // for example, does not instead trigger the file chooser again.
        if (event.target) {
          event.target.blur();
        }
      } catch (exc) {
        setLoadingError(exc);
      }
    }
  }

  const onDtScaleChange = (event) => {
    if (allowThrottledEvent.current) {
      allowThrottledEvent.current = false;
      setDtScale(event.target.valueAsNumber);
    }
  }

  const onPeakChange = (event) => {
    if (allowThrottledEvent.current) {
      allowThrottledEvent.current = false;
      setPeak(event.target.valueAsNumber);
      transferFunctionTexRef.current = 
        makeFluoTransferTex(alpha0, event.target.valueAsNumber, dataGamma, alpha1, dataColor);
    }
  }

  const onDataGammaChange = (event) => {
    if (allowThrottledEvent.current) {
      allowThrottledEvent.current = false;
      setDataGamma(event.target.valueAsNumber);
      transferFunctionTexRef.current = 
        makeFluoTransferTex(alpha0, peak, event.target.valueAsNumber, alpha1, dataColor);
      }
  }
 
  const onFinalGammaChange = (event) => {
   if (allowThrottledEvent.current) {
      allowThrottledEvent.current = false;
      setFinalGamma(event.target.valueAsNumber);
    }
  }

  const onInteractionSpeedupChange = (event) => {
    if (allowThrottledEvent.current) {
       allowThrottledEvent.current = false;
       setInteractionSpeedup(event.target.valueAsNumber);
     }
   }
 
  const onDataColorInputChange = (event) => {
    setDataColor(event.target.value);
    transferFunctionTexRef.current = 
      makeFluoTransferTex(alpha0, peak, dataGamma, alpha1, event.target.value);
  }

  const onSurfaceColorInputChange = (event) => {
    setSurfaceColor(event.target.value);
  }

  const onKeyPress = (event) => {
    if (event.key === 'l') {
      setUseLighting(!useLighting);
    } else if (swcSurfaceMesh) {
      setUseSurface(!useSurface);
    }
  }

  // An example of how the `onCameraChange` prop could be used, with access to the
  // camera and the orbit controller.
  // It's best to make this function a memoized callback, to avoid repeated unncessary
  // `removeEventListener` / `addEventListener` calls in `Vol3dViewer`.
  const onCameraChangeTest = React.useCallback((event) => {
    if (event) {

      const orbitControls = event.target;
      const camera = event.target.object;
      /* eslint-disable no-unused-vars */
      const eye = camera.position;
      const { target: center } = orbitControls;
      const { up } = camera;
      /* eslint-enable no-unused-vars */
    }
  }, []);

  const onWebGLRender = React.useCallback(() => {
    // Events generated by the spinners on the final-gamma control (and others) need to
    // be throttled, to avoid having a backlog of events that continue to be processed
    // after the user stops presssing the spinner.  Standard throttling techniques based
    // on time do not work well, but it does work to throttle so that no new event is
    // processed until the WebGL rendering triggered by the last event has been processed.
    allowThrottledEvent.current = true;
  }, []);
  
  let middle;
  let bottom = <div className="Controls">&nbsp;</div>
  if (loadingError) {
    middle = <div>
      {`Error during loading: ${loadingError.message}`}
    </div>
  } else if (!filename) {
    middle = (
      <div />
    );  
  } else if (!channelSpecs) {
    middle = (
      <div>
        {filename}
      </div>                 
    );
  } else if (!channel) {
    middle = (
      <div className="Channels" >
        {filename}
        <div style={{ textAlign: "left", alignItems: "center" }}>
          {channelSpecs.map((ch) => 
            <div key={ch.name}>
              <input
                type="radio"             
                name="channels-radio-group"
                value={ch.name}
                id={ch.name}
                defaultChecked={ch === channelSpecs[0]}
              />
              <label htmlFor={ch}>{ch.name}: {ch.content}</label>
            </div>
          )}
        </div>
        <button type='button' onClick={onLoadChannel}>Load</button>
      </div>                 
    );
  } else if (!dataUint8) {
    if (!loadingPercent) {
      middle = (
        <div>
          Loading...
        </div>
      );
    } else {
      middle = (
        <div>
          {`Loading... (${loadingPercent}%)`}
        </div>
      );
    }
  } else {
    middle = (
      <Vol3dViewer
        volumeDataUint8={dataUint8}
        volumeSize={volumeSize}
        voxelSize={voxelSize}
        dtScale={dtScale}
        interactionSpeedup={interactionSpeedup}
        transferFunctionTex={transferFunctionTexRef.current}
        finalGamma={finalGamma}
        useLighting={useLighting}
        useSurface={useSurface}
        surfaceMesh={swcSurfaceMesh}
        surfaceColor={surfaceColor}
        onCameraChange={onCameraChangeTest}
        onWebGLRender={onWebGLRender}
      />
    );
    bottom = (
      <div className="Controls">
        Data peak&nbsp;
        <input 
          className="Control"
          type="number"
          value={peak}
          min="0"
          max="255"
          step="1"
          onChange={onPeakChange}
        />
        &nbsp;
        Data &gamma;&nbsp;
        <input 
          className="Control"
          type="number"
          value={dataGamma}
          min="0"
          max="6"
          step="0.01"
          onChange={onDataGammaChange}
        />
        &nbsp;
        Sample spacing&nbsp;
        <input 
          className="Control"
          type="number"
          value={dtScale}
          min="0.1"
          max="10"
          step="0.1"
          onChange={onDtScaleChange}
        />

        &nbsp;
        Interaction speedup&nbsp;
        <input 
          className="Control"
          type="number"
          value={interactionSpeedup}
          min="1"
          max="20"
          step="1"
          onChange={onInteractionSpeedupChange}
        />

        &nbsp;
        Final &gamma;&nbsp;
        <input 
          className="Control"
          type="number"
          value={finalGamma}
          min="0.1"
          max="1000"
          step="0.1"
          onChange={onFinalGammaChange}
        />
      </div>
    )
  }

  return (
    <div className="BasicUI">
      <div className="Controls" >
        <div className="InputControl">
          H5J&nbsp;
          <input
            type="color"
            value={dataColor}
            onChange={onDataColorInputChange}
          />
          &nbsp;
          <FileOrURLInput
            accept=".h5j"
            onChange={onDataFileInputChange}
          />
        </div>
        &nbsp;
        <div className="InputControl">
          SWC&nbsp;
          <input
            type="color"
            value={surfaceColor}
            onChange={onSurfaceColorInputChange}
            disabled={!dataUint8}
          />
          &nbsp;
          <FileOrURLInput
            accept=".swc"
            onChange={onSurfaceFileInputChange}
            disabled={!dataUint8}
          />
        </div>
      </div>
      <div
        className="Middle"
        tabIndex={0}
        onKeyPress={onKeyPress}
        role='link'
      >
        {middle}
      </div>
      {bottom}
    </div>
  );
}

export default H5j3dViewerWithBasicUI;