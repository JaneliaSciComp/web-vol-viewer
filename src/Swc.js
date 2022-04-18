import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils';

/* eslint-disable prefer-template */

// From https://github.com/JaneliaSciComp/SharkViewer/blob/master/src/viewer/util.js
export function parseSwc(swcFile) {
    // split by lines
    const swcAr = swcFile.split("\n");
    const swcJSON = {};
  
    const float = "-?\\d*(?:\\.\\d+)?";
    const pattern = new RegExp(
      "^[ \\t]*(" +
        [
          "\\d+", // index
          "\\d+", // type
          float, // x
          float, // y
          float, // z
          float, // radius
          "-1|\\d+" // parent
        ].join(")[ \\t]+(") +
        ")[ \\t]*$",
      "m"
    );
  
    swcAr.forEach(e => {
      // if line is good, put into json
      const match = e.match(pattern);
      if (match) {
        const id = parseInt(match[1], 10);
  
        swcJSON[id] = {
          id,
          type: parseInt(match[2], 10),
          x: parseFloat(match[3]),
          y: parseFloat(match[4]),
          z: parseFloat(match[5]),
          radius: parseFloat(match[6]),
          parent: parseInt(match[7], 10)
        };
      }
    });
  
    // return json
    return swcJSON;
}

/* eslint-enable prefer-template */

export function makeSwcSurface(swcJson, colorStr) {
  const geometries = [];
  Object.values(swcJson).forEach((v) => {
    if (v.parent !== -1) {
      const par = v.parent;
      const p0 = new THREE.Vector3(swcJson[par].x, swcJson[par].y, swcJson[par].z);
      const p1 = new THREE.Vector3(v.x, v.y, v.z);

      const pos = new THREE.Vector3();
      pos.addVectors(p0, p1).divideScalar(2);
      const height = p0.distanceTo(p1);

      const y = new THREE.Vector3();
      y.subVectors(p0, p1).normalize();

      const x = new THREE.Vector3(1, 0, 0);
      const xOnY = new THREE.Vector3(x.x, x.y, x.z);
      xOnY.projectOnVector(y);
      x.sub(xOnY).normalize();

      const z = new THREE.Vector3();
      z.crossVectors(x, y).normalize();

      const m = new THREE.Matrix4();
      m.makeBasis(x, y, z);

      const radialSegments = 5;
      const geometry = new THREE.CylinderGeometry(swcJson[par].radius, v.radius, height, radialSegments);
      geometry.applyMatrix4(m);
      geometry.translate(pos.x, pos.y, pos.z);
      geometries.push(geometry);
    }
  });
  if (geometries.length > 0) {
    // Keeping all the segments of the SWC as separate geometries reduces Three.js
    // rendering performance.  Merging them into one geometry makes a big difference.
    const mergedGeometry = BufferGeometryUtils.mergeBufferGeometries(geometries);

    const surfaceMaterial = new THREE.MeshLambertMaterial();
    if (colorStr) {
      surfaceMaterial.color.set(colorStr);
    }
    
    const surface = new THREE.Mesh(mergedGeometry, surfaceMaterial);
    return surface;
  }
  return null;
}
