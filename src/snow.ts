/**
 * Falling volumetric snow — ported from the SnowSystemThreeJS project.
 *
 * Every flake is a camera-facing soft round billboard. Positions are wrapped (mod)
 * inside a volume that follows the camera, so the field is effectively infinite for
 * any flake count. Each flake gets a per-drop sinusoidal sway on top of gravity + wind
 * so it drifts down like real snow. `shared` (uTime, uWind) is shared by reference with
 * the accumulation shader so snowfall and wind stay in lockstep.
 */
import {
  InstancedBufferGeometry, BufferAttribute, InstancedBufferAttribute, ShaderMaterial,
  Mesh, Color, Vector3, NormalBlending, MathUtils, PerspectiveCamera,
} from "three";

export interface SnowShared {
  uTime: { value: number };
  uWind: { value: Vector3 };
}

export function createSnow(opts: { camera: PerspectiveCamera; shared: SnowShared; maxCount?: number }) {
  const { camera, shared, maxCount = 30000 } = opts;
  const geometry = new InstancedBufferGeometry();

  const positions = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const aSeed = new Float32Array(maxCount * 3);
  const aRand = new Float32Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    aSeed[i * 3 + 0] = Math.random();
    aSeed[i * 3 + 1] = Math.random();
    aSeed[i * 3 + 2] = Math.random();
    aRand[i] = Math.random();
  }
  geometry.setAttribute("aSeed", new InstancedBufferAttribute(aSeed, 3));
  geometry.setAttribute("aRand", new InstancedBufferAttribute(aRand, 1));

  const uniforms = {
    uTime: shared.uTime,
    uWind: shared.uWind,
    uCameraPos: { value: new Vector3() },
    uVolume: { value: new Vector3(50, 40, 50) },
    uSpeed: { value: 3.2 },
    uSize: { value: 0.07 },
    uSway: { value: 0.5 },
    uOpacity: { value: 0.9 },
    uColor: { value: new Color(0xffffff) },
  };

  const material = new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3  uWind;
      uniform vec3  uCameraPos;
      uniform vec3  uVolume;
      uniform float uSpeed;
      uniform float uSize;
      uniform float uSway;

      attribute vec3  aSeed;
      attribute float aRand;

      varying vec2  vUv;
      varying float vRand;

      void main() {
        vUv = uv;
        vRand = aRand;

        vec3 vol = uVolume;
        // volume tracks the camera, biased slightly upward so flakes fall into view
        vec3 origin = uCameraPos - vec3(vol.x * 0.5, vol.y * 0.4, vol.z * 0.5);

        float speed = uSpeed * (0.6 + 0.7 * aRand);
        vec3 base = aSeed * vol;

        float phase = aRand * 6.2831853;
        float t = uTime;
        vec3 sway = vec3(
          sin(t * 0.7 + phase) + 0.35 * sin(t * 1.6 + phase * 1.7),
          0.0,
          cos(t * 0.6 + phase) + 0.35 * cos(t * 1.3 + phase * 1.3)
        ) * uSway * (0.4 + 0.6 * aRand);

        vec3 disp = vec3(uWind.x, -speed, uWind.z) * t + sway;
        vec3 pos = mod(base + disp - origin, vol) + origin;

        float size = uSize * (0.5 + 1.0 * aRand);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 world = pos + right * (position.x * size) + up * (position.y * size);

        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3  uColor;

      varying vec2  vUv;
      varying float vRand;

      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float disc = smoothstep(1.0, 0.1, d);
        float core = smoothstep(0.6, 0.0, d) * 0.5;
        float alpha = (disc + core) * uOpacity * (0.55 + 0.45 * vRand);
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  geometry.instanceCount = Math.floor(maxCount * 0.5);

  return {
    mesh,
    material,
    uniforms,
    maxCount,
    update(): void {
      uniforms.uCameraPos.value.copy(camera.position);
    },
    setDensity(fraction: number): void {
      geometry.instanceCount = Math.max(1, Math.floor(MathUtils.clamp(fraction, 0, 1) * maxCount));
    },
  };
}
