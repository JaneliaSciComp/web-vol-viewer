// Based on the blog post by Will Usher:
// https://www.willusher.io/webgl/2019/01/13/volume-rendering-with-webgl
// The code here adds lighting, depth-based compositing of a solid surface, 
// mirroring, and little tweaks like dithering to reduce aliasing.

export const vertexShaderVolume =
`
out vec3 rayDirUnnorm;

// Three.js adds built-in uniforms and attributes:
// https://threejs.org/docs/#api/en/renderers/webgl/WebGLProgram
// attribute vec3 position;
// // = object.matrixWorld
// uniform mat4 modelMatrix;
// // = camera.matrixWorldInverse * object.matrixWorld
// uniform mat4 modelViewMatrix;
// // = camera.projectionMatrix
// uniform mat4 projectionMatrix;
// // = camera position in world space
// uniform vec3 cameraPosition;

void main()
{
  rayDirUnnorm = position - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const fragmentShaderVolume = 
`
precision mediump float;
in vec3 rayDirUnnorm;

uniform sampler2D transferTex;
uniform highp sampler3D volumeTex;
uniform float alphaScale;
uniform float dtScale;
uniform float finalGamma;

uniform bool useLighting;
uniform vec3 light0;
uniform vec3 light1;
uniform vec3 light2;
uniform vec3 lightColor0;
uniform vec3 lightColor1;
uniform vec3 lightColor2;
uniform highp vec3 boxSize;

uniform bool useVolumeMirrorX;

// Optional parameters, for when a solid surface is being drawn along with
// the volume data.
uniform bool useSurface;
uniform float near;
uniform float far;
uniform sampler2D surfaceColorTex;
uniform sampler2D surfaceDepthTex;

// Three.js adds built-in uniforms and attributes:
// https://threejs.org/docs/#api/en/renderers/webgl/WebGLProgram
// uniform vec3 cameraPosition;

vec2 intersectBox(vec3 orig, vec3 dir) {
  vec3 boxMin = vec3(-0.5) * boxSize;
  vec3 boxMax = vec3( 0.5) * boxSize;
  vec3 invDir = 1.0 / dir;
  vec3 tmin0 = (boxMin - orig) * invDir;
  vec3 tmax0 = (boxMax - orig) * invDir;
  vec3 tmin = min(tmin0, tmax0);
  vec3 tmax = max(tmin0, tmax0);
  float t0 = max(tmin.x, max(tmin.y, tmin.z));
  float t1 = min(tmax.x, min(tmax.y, tmax.z));
  return vec2(t0, t1);
}

float cameraDistanceFromDepth(float depth) {
  float zN = 2.0 * depth - 1.0;
  float z = 2.0 * near * far / (far + near - zN * (far - near));
  return near + z;
}

void main(void) {
  vec3 rayDir = normalize(rayDirUnnorm);

  rayDir.x = useVolumeMirrorX ? -rayDir.x : rayDir.x;
  vec3 cameraPositionAdjusted = cameraPosition;
  cameraPositionAdjusted.x = useVolumeMirrorX ? -cameraPositionAdjusted.x : cameraPositionAdjusted.x;

  // Find the part of the ray that intersects the box, where this part is
  // expressed as a range of "t" values (with "t" being the traditional
  // parameter for a how far a point is along a ray).
  vec2 tBox = intersectBox(cameraPositionAdjusted, rayDir);

  ivec2 surfaceTexSize = ivec2(0);
  vec2 surfaceTexCoord = vec2(0);
  if (useSurface) {
    // If a surface is being drawn, then adjust the range of "t" values
    // so the farthest value corresponds to where the surface is, which
    // comes from the depth-buffer value in the texture.
    surfaceTexSize = textureSize(surfaceColorTex, 0);
    surfaceTexCoord = gl_FragCoord.xy / vec2(surfaceTexSize);
    float depth = texture(surfaceDepthTex, surfaceTexCoord).x;
    float dist = cameraDistanceFromDepth(depth);
    tBox.y = min(tBox.y, dist);

    // It also may be the case that the surface extends outside the volume.
    // If it is between the camera and the volume, the starting "t" value
    // must be pushed back to accomodate it (with a little extra tolerance
    // included) or it will appear as black.
    tBox.x = min(tBox.x, dist - 0.0001);
  }

  if (tBox.x >= tBox.y) {
    discard;
  }

  tBox.x = max(tBox.x, 0.0);

  ivec3 volumeTexSize = textureSize(volumeTex, 0);
  vec3 dt0 = 1.0 / (vec3(volumeTexSize) * abs(rayDir));
  float dt = min(dt0.x, min(dt0.y, dt0.z));

  dt *= dtScale;

  // Prevents a lost WebGL context.
  if (dt < 0.00001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Ray starting point, in the "real" space where the box may not be a cube.
  vec3 p = cameraPositionAdjusted + tBox.x * rayDir;

  // Dither to reduce banding (aliasing).
  // https://www.marcusbannerman.co.uk/articles/VolumeRendering.html
  float random = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
  random *= 5.0;
  p += random * dt * rayDir;

  // Ray starting point, and change in ray point with each step, for the space where
  // the box has been warped to a cube, for accessing the cubical data texture.
  // The vec3(0.5) is necessary because rays are defined in the space where the box is
  // centered at the origin, but texture look-ups have the origin at a box corner.
  vec3 pSized = p / boxSize + vec3(0.5);
  vec3 dPSized = (rayDir * dt) / boxSize;

  // This renderer matches VVD_Viewer when looking along the smallest axis of the volume,
  // but looks too bright on the other axes.  So normalize alpha to reduce it on these
  // other axes.
  float l = length(rayDir * boxSize);
  float lMin = min(boxSize.x, min(boxSize.y, boxSize.z));
  float alphaNormalization = lMin / l;
  alphaNormalization *= alphaScale;

  // A step of one voxel, for computing the gradient by a central difference.
  vec3 dg = vec3(1) / vec3(volumeTexSize);

  // Most browsers do not need this initialization, but add it to be safe.
  gl_FragColor = vec4(0.0);

  for (float t = tBox.x; t < tBox.y; t += dt) {
    float v = texture(volumeTex, pSized).r;
    vec4 vColor = texture(transferTex, vec2(v, 0.5));
      
    vColor.a *= alphaNormalization;

    // Compute simple lighting when the color is not fully transparent.
    if (useLighting && vColor.a > 0.0)
    {
      // Gradient approximated by the central difference.
      float dataDxA = texture(volumeTex, pSized + vec3(dg.x, 0.0,  0.0 )).r;
      float dataDxB = texture(volumeTex, pSized - vec3(dg.x, 0.0,  0.0 )).r;
      float dataDyA = texture(volumeTex, pSized + vec3(0.0,  dg.y, 0.0 )).r;
      float dataDyB = texture(volumeTex, pSized - vec3(0.0,  dg.y, 0.0 )).r;
      float dataDzA = texture(volumeTex, pSized + vec3(0.0,  0.0,  dg.z)).r;
      float dataDzB = texture(volumeTex, pSized - vec3(0.0,  0.0,  dg.z)).r;
      vec3 grad = vec3(dataDxA - dataDxB, dataDyA - dataDyB, dataDzA - dataDzB);  

      // When using the gradient as the surface normal for shading, we always want to
      // act as if the surface is facing the camera.  So flip the gradient if it points
      // away from the camera (i.e., negate it if dot(grad, rayDir) > 0.0)
      grad *= -sign(dot(grad, rayDir));

      float gradLength = length(grad);
      grad /= gradLength;
      float gradStrength = (gradLength < 0.0001) ? 0.0 : 1.0;

      vec3 lighting0 = max(dot(grad, light0), 0.0) * lightColor0;
      vec3 lighting1 = max(dot(grad, light1), 0.0) * lightColor1;
      vec3 lighting2 = max(dot(grad, light2), 0.0) * lightColor2;
      vec3 lighting = min(lighting0 + lighting1 + lighting2, vec3(1.0));
      vColor.rgb *= lighting;
      vColor *= gradStrength;

      /*
      // Uncomment to visualize the gradient for debugging.
      gl_FragColor.rgb = (grad + vec3(1.0)) / 2.0;
      gl_FragColor.a = 1.0;
      gl_FragColor.a *= gradStrength;
      return;
      */
    }

    // Adding this point's color is the compositing operation "A over B", where 
    // A is gl_FragColor (the samples in front of this one on the ray) and 
    // B is vColor (this sample), using premultiplied alpha for the B color 
    // (i.e., vColor.a * vColor.rgb).
    // https://en.wikipedia.org/wiki/Alpha_compositing#Straight_versus_premultiplied
    gl_FragColor.rgb += (1.0 - gl_FragColor.a) * vColor.a * vColor.rgb;
    gl_FragColor.a += (1.0 - gl_FragColor.a) * vColor.a;

    if (gl_FragColor.a >= 0.95) {
      break;
    }

    // Move to the next point along the ray.
    pSized += dPSized;
  }

  float g = 1.0 / finalGamma;
  gl_FragColor = pow(gl_FragColor, vec4(g, g, g, 1));

  if (useSurface) {
    // If a surface is being drawn, the background color comes from the texture
    // captured when the surface was rendered (in its own pass).
    vec3 surfaceColor = texture(surfaceColorTex, surfaceTexCoord).rgb;
    float surfaceAlpha = 1.0;
    gl_FragColor.rgb += (1.0 - gl_FragColor.a) * surfaceAlpha * surfaceColor.rgb;
    // The following line is no longer needed with the final assignment, below.
    // gl_FragColor.a += (1.0 - gl_FragColor.a) * surfaceAlpha;
  }

  // A few browsers show some artifacts if the final alpha value is not 1.0,
  // probably a version of the issues discussed here:
  // https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html
  gl_FragColor.a = 1.0;
}
`
