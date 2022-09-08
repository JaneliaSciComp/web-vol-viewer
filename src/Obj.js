import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';

export function isObjSource(src) {
  if (typeof src === 'string') {
    if (src.endsWith('.obj')) {
      return true;
    }
  } else if ('name' in src) {
    if (src.name.endsWith('.obj')) {
      return true;
    }
  }
  return false;
}

export function makeObjSurface(text, colorStr) {
  const loader = new OBJLoader();
  const group = loader.parse(text);
  for (let i = 0; i < group.children.length; i += 1) {
    if (group.children[i] instanceof THREE.Mesh) {
      const mesh = group.children[i];

      const material = new THREE.MeshLambertMaterial();
      if (colorStr) {
        material.color.set(colorStr);
      }
      mesh.material = material;

      return mesh;
    }
  }
  return null;
}
