// A component to do 3D direct volume rendering of `Uint8Array` data volume.
// Also supports depth-based compositing within the volume of an opaque 3D surface,
// specied as a Three.js `Mesh`.
// Includes props for controlling the details of the rendering, but no user interface
// controls. 

import React from 'react';
import PropTypes from 'prop-types';
import './Vol3dViewer.css';

import * as THREE from 'three';
import OrbitUnlimitedControls from '@janelia/three-orbit-unlimited-controls';

import { vertexShaderVolume, fragmentShaderVolume } from './Shaders';

function Vol3dViewer(props) {
  const {
    volumeDataUint8,
    volumeSize,
    voxelSize,
    useVolumeMirrorX,
    alphaScale,
    dtScale,
    transferFunctionTex,
    finalGamma,
    interactionSpeedup,
    cameraPosition,
    cameraTarget,
    cameraUp,
    cameraFovDegrees,
    orbitZoomSpeed,
    useLighting,
    useSurface,
    surfaceMesh,
    surfaceColor,
    onCameraChange,
    onWebGLRender,
  } = props;

  // For mounting the Three.js renderer image in the appropriate place in the DOM.
  const mountRef = React.useRef(null);

  // Some Three.js values that need to be referenced after initialization.
  // According to https://reactjs.org/docs/hooks-reference.html#useref, 
  // `useRef` "is handy for keeping any mutable value around similar to how you’d use
  // instance fields in classes."  Note that trying to store these particular values
  // with `useState` seems to cause repeated updates and a crash.
  const rendererRef = React.useRef(null);
  const cameraRef = React.useRef(null);
  const sceneRef = React.useRef(null);
  const boxRef = React.useRef(null);
  const boxMaterialRef = React.useRef(null);
  const trackballRef = React.useRef(null);
  const surfaceRef = React.useRef(null);
  const surfaceTargetRef = React.useRef(null);
  const onCameraChangeRef = React.useRef(null);
  const prevHeightRef = React.useRef(null);

  const cameraNear = 0.01;
  const cameraFar = 10.0;
  // Different props affect different parts of the Three.js state, and a change to only
  // one prop should not causes all the Three.js state to be reinitialized.  It is not clear
  // that the Three.js state could be split between multiple React components, each having
  // only the appropriate subset of the props.  So this component makes significant use of
  // the `React.useEffect` hook, with a different hook for each part of the Three.js state
  // that needs to be initialized based on particular props.  Those particular props, and
  // any other data dependent on them, are listed in the array that is the second argument
  // to `React.useEffect`, and the code that is first argument is executed only the when
  // those props change.

  React.useEffect(() => {

    const initRenderer = () => {
      console.log('initRenderer');

      // Three.js now uses WebGL 2 by default, so no special canvas context is needed.
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setClearColor("#000000");
  
      // For a shader using `gl_FragCoord`, as in this code (Shaders.js), the following
      // use of `setPixelRatio` is not recommended in this guide:
      // https://threejs.org/manual/#en/responsive
      // On the other hand, the Three.js authors say the following use is correct:
      // https://github.com/mrdoob/three.js/issues/12770

      // Eliminates some artifacts on MacBook Pros with Retina displays.
      renderer.setPixelRatio(window.devicePixelRatio);
  
      // Must be called after setPixelRatio().
      const width = mountRef.current.clientWidth;
      const height = mountRef.current.clientHeight;
      renderer.setSize(width, height);

      // The `clientHeight` does not seem to change when resizing to a shorter height.
      // So keep track of the `innerHeight`, which does change, and use it for a correction.
      prevHeightRef.current = window.innerHeight;

      mountRef.current.appendChild(renderer.domElement);
      return renderer;
    }

    const initScene = () => {
      console.log('initScene');

      const scene = new THREE.Scene();

      // A box in which the 3D volume texture will be rendered.  The box will be
      // centered at the origin, with X in [-0.5, 0.5] so the width is 1, and
      // Y (height) and Z (depth) scaled to match.

      const s = volumeSize[0] * voxelSize[0];
      const boxWidth = 1;
      const boxHeight = volumeSize[1] * voxelSize[1] / s;
      const boxDepth = volumeSize[2] * voxelSize[2] / s;
      const boxSize = new THREE.Vector3(boxWidth, boxHeight, boxDepth);
      console.log(`Voxel size ${voxelSize[0]}, ${voxelSize[1]}, ${voxelSize[2]}`);
      console.log(`Box size ${boxWidth}, ${boxHeight}, ${boxDepth}`);
  
      const boxGeometry = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);
      const box = new THREE.Mesh(boxGeometry);
      scene.add(box);
  
      // Lights, to be used both during rendering the volume, and rendering the optional surface.

      const directionalLightPos0 = new THREE.Vector3(-0.2,  1.0,  0.0).normalize();
      const directionalLightPos1 = new THREE.Vector3(-1.0, -1.0,  1.0).normalize();
      const directionalLightPos2 = new THREE.Vector3( 1.0, -1.0, -1.0).normalize();
      const directionalLightColor0 = new THREE.Color(0.9, 0.9, 0.9);
      const directionalLightColor1 = new THREE.Color(0.4, 0.5, 0.6);
      const directionalLightColor2 = new THREE.Color(0.7, 0.8, 1.0);
      const directionalLight0 = new THREE.DirectionalLight(directionalLightColor0.getHex(), 1);
      directionalLight0.position.copy(directionalLightPos0);
      const directionalLight1 = new THREE.DirectionalLight(directionalLightColor1.getHex(), 1);
      directionalLight1.position.copy(directionalLightPos1);
      const directionalLight2 = new THREE.DirectionalLight(directionalLightColor2.getHex(), 1);
      directionalLight2.position.copy(directionalLightPos2);
  
      scene.add(directionalLight0);
      scene.add(directionalLight1);
      scene.add(directionalLight2);

      return ([scene, box, boxSize, directionalLight0, directionalLight1, directionalLight2]);  
    }

    const initMaterial = (renderer, box, boxSize, directionalLight0, directionalLight1, directionalLight2) => {
      const volumeTexture = new THREE.DataTexture3D(volumeDataUint8, volumeSize[0], volumeSize[1], volumeSize[2]);
      volumeTexture.format = THREE.RedFormat
      volumeTexture.type = THREE.UnsignedByteType
      // Disabling mimpaps saves memory.
      volumeTexture.generateMipmaps = false;
      // Linear filtering disables LODs, which do not help with volume rendering.
      volumeTexture.minFilter = THREE.LinearFilter;
      volumeTexture.magFilter = THREE.LinearFilter;
      volumeTexture.needsUpdate = true
  
      const lightColor0 = directionalLight0.color;
      const lightColor1 = directionalLight1.color;
      const lightColor2 = directionalLight2.color;
      const lightColorV0 = new THREE.Vector3(lightColor0.r, lightColor0.g, lightColor0.b);
      const lightColorV1 = new THREE.Vector3(lightColor1.r, lightColor1.g, lightColor1.b);
      const lightColorV2 = new THREE.Vector3(lightColor2.r, lightColor2.g, lightColor1.b);

      const boxMaterial = new THREE.ShaderMaterial({
        vertexShader: vertexShaderVolume,
        fragmentShader: fragmentShaderVolume,
        side: THREE.BackSide,
        uniforms: {	
          boxSize: new THREE.Uniform(boxSize),
          volumeTex: new THREE.Uniform(volumeTexture),
          light0: new THREE.Uniform(directionalLight0.position),
          light1: new THREE.Uniform(directionalLight1.position),
          light2: new THREE.Uniform(directionalLight2.position),
          lightColor0: new THREE.Uniform(lightColorV0),
          lightColor1: new THREE.Uniform(lightColorV1),
          lightColor2: new THREE.Uniform(lightColorV2),
          near: new THREE.Uniform(cameraNear),
          far: new THREE.Uniform(cameraFar),

          // The following are set separately, since they are based on `props` values that can
          // change often, and should not trigger complete re-initialization.
          transferTex: new THREE.Uniform(null),
          alphaScale: new THREE.Uniform(0),
          dtScale: new THREE.Uniform(0),
          finalGamma: new THREE.Uniform(0),
          useLighting: new THREE.Uniform(true),
          useSurface: new THREE.Uniform(false),
          surfaceColorTex: new THREE.Uniform(null),
          surfaceDepthTex: new THREE.Uniform(null),
          useVolumeMirrorX: new THREE.Uniform(false)
        }
      });
  
      /* eslint no-param-reassign: ["error", { "props": false }] */
      box.material = boxMaterial;

      return [boxMaterial]
    }

    const renderer = initRenderer();
    const [scene, box, boxSize, light0, light1, light2] = initScene();
    const [boxMaterial] = initMaterial(renderer, box, boxSize, light0, light1, light2);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    boxRef.current = box;
    boxMaterialRef.current = boxMaterial;

    // This "clean up" function will be called when the component is unmounted.  The copy of 
    // `mountRef.current` eliminates the following warning from React: "The ref value 'mountRef.current'
    // will likely have changed by the time this effect cleanup function runs. If this ref points to a
    // node rendered by React, copy 'mountRef.current' to a variable inside the effect, and use that
    // variable in the cleanup function."
    const mnt = mountRef.current;
    return (() => mnt.removeChild(renderer.domElement));
  }, [volumeDataUint8, volumeSize, voxelSize]);

  React.useEffect(() => {
    if (rendererRef.current) {
      console.log('initCamera');
      const renderer = rendererRef.current;
      const size = new THREE.Vector2();
      renderer.getSize(size);
      const camera = new THREE.PerspectiveCamera(
        cameraFovDegrees,
        size.x / size.y,
        cameraNear,
        cameraFar
      );
      camera.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
      camera.up.set(cameraUp[0], cameraUp[1], cameraUp[2]);

      const trackball = new OrbitUnlimitedControls(camera, renderer.domElement);
      trackball.target.set(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
      trackball.zoomSpeed = orbitZoomSpeed;

      // Match the modifier keys used by VVD_Viewer, as described in the FluoRender user manual:
      // http://www.sci.utah.edu/releases/fluorender_v2.20/FluoRender2.20_Manual.pdf
      // Appendix "C. Keyboard Shortcuts"
      trackball.usePanModAlt = true;
      trackball.usePanModCtrl = true;
      trackball.usePanModMeta = true;

      cameraRef.current = camera;
      trackballRef.current = trackball;
    }
  }, [rendererRef, cameraPosition, cameraUp, cameraTarget, cameraFovDegrees, orbitZoomSpeed]);

  // This rendering function is "memoized" so it can be used in `useEffect` blocks.
  const renderScene = React.useCallback(() => {
    const surfaceVisible = surfaceRef.current && surfaceRef.current.visible;
    if (surfaceVisible) {
      boxRef.current.visible = false;

      const size = new THREE.Vector2();
      rendererRef.current.getDrawingBufferSize(size);
      if (!surfaceTargetRef.current || surfaceTargetRef.current.width !== size.x || surfaceTargetRef.current.height !== size.y) {        
        surfaceTargetRef.current  = new THREE.WebGLRenderTarget(size.x, size.y);
        surfaceTargetRef.current.texture.format = THREE.RGBFormat;
        surfaceTargetRef.current.texture.minFilter = THREE.NearestFilter;
        surfaceTargetRef.current.texture.magFilter = THREE.NearestFilter;
        surfaceTargetRef.current.texture.generateMipmaps = false;
        surfaceTargetRef.current.depthBuffer = true;
        surfaceTargetRef.current.depthTexture = new THREE.DepthTexture(size.x, size.y);
        surfaceTargetRef.current.depthTexture.format = THREE.DepthFormat;
        surfaceTargetRef.current.depthTexture.type = THREE.UnsignedShortType;
        surfaceTargetRef.current.stencilBuffer = false;

        boxMaterialRef.current.uniforms.surfaceColorTex.value = surfaceTargetRef.current.texture;
        boxMaterialRef.current.uniforms.surfaceDepthTex.value = surfaceTargetRef.current.depthTexture;
      }

      rendererRef.current.setRenderTarget(surfaceTargetRef.current);
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      rendererRef.current.setRenderTarget(null);

      surfaceRef.current.visible = false;  
      boxRef.current.visible = true;
    }

    rendererRef.current.render(sceneRef.current, cameraRef.current);

    if (surfaceVisible) {
      surfaceRef.current.visible = true;
    }

    if (onWebGLRender) {
      onWebGLRender();
    }
  }, [onWebGLRender]);

  React.useEffect(() => {
    console.log('update OrbitUnlimitedControls');

    trackballRef.current.addEventListener("change", renderScene);

    // This `useEffect` should run only once, but if it ever ran again, this "clean up"
    // function would ensure that the current `renderScene` is no longer called.
    return (() => trackballRef.current.removeEventListener("change", renderScene));
  }, [renderScene]);

  React.useEffect(() => {
    console.log('update OrbitUnlimitedControls 2');

    if (onCameraChange) {
      if (onCameraChangeRef.current) {
        trackballRef.current.removeEventListener("change", onCameraChangeRef.current);
      }
      onCameraChangeRef.current = onCameraChange;
      trackballRef.current.addEventListener("change", onCameraChangeRef.current);
    }

    // This `useEffect` should run only once, but if it ever ran again, this "clean up"
    // function would ensure that the current `onCameraChange` is no longer called.
    return (() => trackballRef.current.removeEventListener("change", onCameraChangeRef.current));
  }, [onCameraChange]);

  React.useEffect(() => {
    console.log('update box material');
  
    boxMaterialRef.current.uniforms.transferTex.value = transferFunctionTex;
    boxMaterialRef.current.uniforms.alphaScale.value = alphaScale;
    boxMaterialRef.current.uniforms.dtScale.value = dtScale;
    boxMaterialRef.current.uniforms.finalGamma.value = finalGamma;
    boxMaterialRef.current.uniforms.useLighting.value = useLighting;
    boxMaterialRef.current.uniforms.useSurface.value = useSurface;
    boxMaterialRef.current.uniforms.useVolumeMirrorX.value = useVolumeMirrorX;

    // This `useEffect` follows the first React rendering, so it is necessary to
    // explicitly force a Three.js rendering to make the volme visible before any
    // interactive camera motion.
    renderScene();
  }, [alphaScale, dtScale, finalGamma, renderScene, transferFunctionTex, useLighting, useSurface, useVolumeMirrorX]);

  React.useEffect(() => {
    const initSurface = () => {
      console.log('initSurface');

      if (surfaceRef.current) {
        sceneRef.current.remove(surfaceRef.current);
      }
      if (surfaceMesh) {
        sceneRef.current.add(surfaceMesh);
        if (surfaceRef.current) {
          surfaceMesh.visible = surfaceRef.current.visible;
        }
      }

      return surfaceMesh;
    }

    surfaceRef.current = initSurface();
    renderScene();
  }, [renderScene, sceneRef, surfaceRef, surfaceMesh]);

  // Surface color must be changed with `useEffect` block or color will not be applied on
  // the second or subsequent change to `surfaceMesh` (since the new `surfaceMesh` is itself
  // applied with `useEffect`).
  React.useEffect(() => {
    console.log('init surfaceColor');

    if (surfaceRef.current) {
      surfaceRef.current.material.color.set(surfaceColor);
      renderScene();
    }
  }, [renderScene, surfaceColor, surfaceMesh]);

  if (surfaceRef.current) {
    surfaceRef.current.visible = useSurface;
  }

  // When the window is resized, force an update to the camera aspect ratio as part of scene rendering.
  React.useEffect(() => {
    let timeout;
    const handleResize = () => {
      clearTimeout(timeout);
      // Wait a bit before rendering to improve performance.s
      timeout = setTimeout(() => {
        const width = mountRef.current.clientWidth;
        let height = mountRef.current.clientHeight;
        
        // The `clientHeight` does not seem to change when resizing to a shorter height.
        // So keep track of the `innerHeight`, which does change, and use it for a correction.
        if (window.innerHeight < prevHeightRef.current) {
          height -= prevHeightRef.current - window.innerHeight;
        }
        prevHeightRef.current = window.innerHeight;

        rendererRef.current.setSize(width, height);
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        renderScene();
      }, 200);
    }
    window.addEventListener("resize", handleResize)
    return (() => window.removeEventListener("resize", handleResize));
  }, [renderScene]);

  if (rendererRef.current) {
    renderScene();
  }

  React.useEffect(() => {
    if (interactionSpeedup > 1) {
      const setRes = (d) => {
        rendererRef.current.setPixelRatio(window.devicePixelRatio / d);
        const width = mountRef.current.clientWidth;
        const height = mountRef.current.clientHeight;
        rendererRef.current.setSize(width, height);
        renderScene();
      }
      const mousedown = () => setRes(interactionSpeedup);
      const mouseup = () => setRes(1);
      rendererRef.current.domElement.addEventListener("mousedown", mousedown);
      rendererRef.current.domElement.addEventListener("mouseup", mouseup);
      return (() => {
        rendererRef.current.domElement.removeEventListener("mousedown", mousedown);
        rendererRef.current.domElement.removeEventListener("mouseup", mouseup);  
      });
    }
    return (() => {});
  }, [interactionSpeedup, renderScene]);

  // Check for WebGL 2 support, and store the result, to avoid creating too may contexts
  // when checking with each rendering.
  const gl2Ref = React.useRef(true);
  React.useEffect(() => {
    gl2Ref.current = document.createElement("canvas").getContext("webgl2");
  }, [gl2Ref]);

  if (!gl2Ref.current) {
    return (
      <div className="Fallback">
        WebGL 2 is not supported in this browser.
      </div>
    );
  }

  // The `ref` here sets up the mounting of the Three.js renderer image in the
  // appropriate place in the DOM.
  return (
    <div className="Vol3dViewer"
      ref={mountRef}
    />
  );
}

Vol3dViewer.propTypes = {
  // A JavaScript `Uint8Array`
  volumeDataUint8: PropTypes.shape({
    buffer: PropTypes.shape({ byteLength: PropTypes.number }),
  }).isRequired,
  volumeSize: PropTypes.arrayOf(PropTypes.number).isRequired,
  voxelSize: PropTypes.arrayOf(PropTypes.number).isRequired,
  useVolumeMirrorX: PropTypes.bool,
  alphaScale: PropTypes.number,
  dtScale: PropTypes.number,
    // A Three.js `DataTexture` (https://threejs.org/docs/#api/en/textures/DataTexture)
  transferFunctionTex: PropTypes.shape({ type: PropTypes.number }).isRequired,
  finalGamma: PropTypes.number,
  interactionSpeedup: PropTypes.number,
  cameraPosition: PropTypes.arrayOf(PropTypes.number),
  cameraTarget: PropTypes.arrayOf(PropTypes.number),
  cameraUp: PropTypes.arrayOf(PropTypes.number),
  cameraFovDegrees: PropTypes.number,
  orbitZoomSpeed: PropTypes.number,
  useLighting: PropTypes.bool,
  useSurface: PropTypes.bool,
  // A Three.js `Mesh` (https://threejs.org/docs/#api/en/objects/Mesh)
  surfaceMesh: PropTypes.shape({
    visible: PropTypes.bool
  }),
  surfaceColor: PropTypes.string,
  onCameraChange: PropTypes.func,
  onWebGLRender: PropTypes.func,
};

Vol3dViewer.defaultProps = {
  useVolumeMirrorX: false,
  alphaScale: 1.0,
  dtScale: 1.0,
  finalGamma: 4.5,
  interactionSpeedup: 1,
  cameraPosition: [0, 0, -2],
  cameraTarget: [0, 0, 0],
  // Gives the correct orientation for Janelia FlyLight datasets.
  cameraUp: [0, -1, 0],
  cameraFovDegrees: 45.0,
  orbitZoomSpeed: 0.15,
  useLighting: true,
  useSurface: false,
  surfaceMesh: null,
  surfaceColor: '#00ff00',
  onCameraChange: null,
  onWebGLRender: null
};

export default Vol3dViewer;
