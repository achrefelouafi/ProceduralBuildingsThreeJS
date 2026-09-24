/**
 * Stylized "toy diorama" environment built around the pastel building:
 *
 *  - a floating beveled pedestal (soil sides, grass top) that resizes with the
 *    building, with a pale plaza slab + curb under the footprint;
 *  - procedural low-poly props in the building's palette: trees (two greens +
 *    pink blossoms), bushes, and teal street lamps with warm bulbs;
 *  - a gradient sky dome shader (horizon/zenith mix, sun glow, night stars)
 *    and slowly drifting low-poly clouds;
 *  - a three-preset lighting rig (golden hour / day / night) that drives the
 *    sky, fog, sun/fill, lamp glow, window glass emissive, and the post grade.
 *
 * Everything is generated — no textures or external assets.
 */
import {
  AmbientLight, BackSide, CanvasTexture, Color, CylinderGeometry, DirectionalLight,
  FogExp2, Group, IcosahedronGeometry, Material, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, PCFSoftShadowMap,
  Scene, ShaderMaterial, SphereGeometry, Vector3, WebGLRenderer, BoxGeometry,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { hash01 } from "./rng";
import type { PostFX } from "./postfx";

export type PresetName = "golden hour" | "day" | "night";

/** building bounding box the diorama is fitted to (meters) */
export interface Footprint {
  width: number;
  length: number;
  height: number;
}

interface Preset {
  horizon: number; zenith: number; haze: number;      // sky gradient colors
  sunColor: number; sunIntensity: number;
  sunDir: Vector3;                                    // normalized, y-up world
  fillColor: number; fillIntensity: number;
  ambColor: number; ambIntensity: number;
  fogColor: number; fogDensity: number;
  cloudColor: number; cloudEmissive: number;
  night: number;                                      // 0..1 star visibility
  lampIntensity: number;                              // point light strength
  lampEmissive: number;                               // bulb emissive intensity
  glassEmissive: number;                              // window glow (night)
  exposure: number; envIntensity: number;
  bloom: number; bloomThreshold: number;
  saturation: number; contrast: number; vignette: number;
}

const PRESETS: Record<PresetName, Preset> = {
  "golden hour": {
    horizon: 0xffc9a2, zenith: 0x6f9fd8, haze: 0xd8a98f,
    sunColor: 0xffb36b, sunIntensity: 3.0,
    sunDir: new Vector3(0.85, 0.42, 0.55).normalize(),
    fillColor: 0x8fb4e8, fillIntensity: 0.45,
    ambColor: 0xffe0c2, ambIntensity: 0.3,
    fogColor: 0xe8b896, fogDensity: 0.0035,
    cloudColor: 0xfff1e2, cloudEmissive: 0.12,
    night: 0,
    lampIntensity: 0, lampEmissive: 0.35, glassEmissive: 0,
    exposure: 1.0, envIntensity: 0.38,
    bloom: 0.18, bloomThreshold: 1.0, saturation: 1.12, contrast: 1.05, vignette: 0.24,
  },
  day: {
    horizon: 0xbfe0f2, zenith: 0x4a90d9, haze: 0xaac6d2,
    sunColor: 0xfff3e0, sunIntensity: 2.7,
    sunDir: new Vector3(0.6, 0.8, 0.42).normalize(),
    fillColor: 0xa8c8f0, fillIntensity: 0.4,
    ambColor: 0xdfeaf5, ambIntensity: 0.32,
    fogColor: 0xc4d8e4, fogDensity: 0.002,
    cloudColor: 0xffffff, cloudEmissive: 0.05,
    night: 0,
    lampIntensity: 0, lampEmissive: 0.15, glassEmissive: 0,
    exposure: 1.0, envIntensity: 0.45,
    bloom: 0.1, bloomThreshold: 1.15, saturation: 1.07, contrast: 1.03, vignette: 0.18,
  },
  night: {
    horizon: 0x2a3550, zenith: 0x0a0e1e, haze: 0x1c2438,
    sunColor: 0x9fb6e8, sunIntensity: 0.55, // moonlight
    sunDir: new Vector3(-0.55, 0.75, -0.4).normalize(),
    fillColor: 0x33427a, fillIntensity: 0.25,
    ambColor: 0x2a3552, ambIntensity: 0.3,
    fogColor: 0x141b2e, fogDensity: 0.004,
    cloudColor: 0x2e3852, cloudEmissive: 0.02,
    night: 1,
    lampIntensity: 14, lampEmissive: 3.2, glassEmissive: 1.35,
    exposure: 1.0, envIntensity: 0.12,
    bloom: 0.55, bloomThreshold: 0.7, saturation: 1.02, contrast: 1.05, vignette: 0.32,
  },
};

/** soft radial gradient used as a contact-shadow patch under the building */
function makeAoTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.65, "rgba(0,0,0,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new CanvasTexture(c);
}

export class Environment {
  readonly sun = new DirectionalLight(0xffb36b, 3.2);
  readonly fill = new DirectionalLight(0x8fb4e8, 0.5);
  readonly ambient = new AmbientLight(0xffe0c2, 0.35);
  /** plaza-top duplicates that the snow shader extrudes (toggled with snow) */
  snowShell: Group | null = null;
  /** materials rain wetness should also soak (plaza, grass) */
  readonly wetTargets: Material[] = [];

  preset: PresetName = "golden hour";

  private scene: Scene;
  private renderer: WebGLRenderer;
  private skyMat: ShaderMaterial;
  private clouds = new Group();
  private diorama = new Group();
  private lamps: { bulb: MeshStandardMaterial; light: PointLight }[] = [];
  private glassMats: MeshStandardMaterial[] = [];
  private shellMaterial: Material | null = null;
  private builtRadius = -1;
  private aoTex = makeAoTexture();

  // stable prop materials (recolored by presets only via lighting, not swapped)
  private matSoil = new MeshStandardMaterial({ color: 0x6b5140, roughness: 1, flatShading: true });
  private matGrass = new MeshStandardMaterial({ color: 0x84b06a, roughness: 1 });
  private matPlaza = new MeshStandardMaterial({ color: 0xd8d1c5, roughness: 0.95 });
  private matCurb = new MeshStandardMaterial({ color: 0xb9b2a6, roughness: 1 });
  private matTrunk = new MeshStandardMaterial({ color: 0x8a5f45, roughness: 1, flatShading: true });
  private matLeafA = new MeshStandardMaterial({ color: 0x79a862, roughness: 1, flatShading: true });
  private matLeafB = new MeshStandardMaterial({ color: 0x5b8f52, roughness: 1, flatShading: true });
  private matBloom = new MeshStandardMaterial({ color: 0xe7aebc, roughness: 1, flatShading: true });
  private matPost = new MeshStandardMaterial({ color: 0x1d4a52, roughness: 0.6, metalness: 0.2 });
  private matCloud = new MeshStandardMaterial({ color: 0xfff1e2, roughness: 1, flatShading: true });

  constructor(scene: Scene, renderer: WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    // image-based lighting for gentle PBR reflections
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    scene.fog = new FogExp2(0xe8b896, 0.0035);

    // --- gradient sky dome (horizon/zenith mix + sun glow + night stars) ---
    this.skyMat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new Color(0xffc9a2) },
        uZenith: { value: new Color(0x6f9fd8) },
        uHaze: { value: new Color(0xd8a98f) },
        uSunDir: { value: new Vector3(0.85, 0.42, 0.55).normalize() },
        uSunColor: { value: new Color(0xffb36b) },
        uNight: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pin to the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon, uZenith, uHaze, uSunColor;
        uniform vec3 uSunDir;
        uniform float uNight, uTime;
        varying vec3 vDir;

        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          // above horizon: warm band melting into zenith; below: soft haze
          vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          vec3 below = mix(uHorizon, uHaze, clamp(-h * 4.0, 0.0, 1.0));
          vec3 col = mix(below, sky, smoothstep(-0.03, 0.06, h));

          // sun disc + wide glow
          float s = clamp(dot(d, uSunDir), 0.0, 1.0);
          col += uSunColor * (pow(s, 350.0) * 1.6 + pow(s, 12.0) * 0.28);

          // stars fade in at night (twinkle slightly)
          vec3 cell = floor(d * 160.0);
          float star = step(0.9975, hash13(cell));
          float tw = 0.6 + 0.4 * sin(uTime * 2.0 + hash13(cell + 7.0) * 40.0);
          col += vec3(0.9, 0.95, 1.0) * star * tw * uNight * smoothstep(0.05, 0.3, h);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const dome = new Mesh(new SphereGeometry(400, 32, 16), this.skyMat);
    dome.frustumCulled = false;
    scene.add(dome);

    // --- drifting low-poly clouds ---
    this.buildClouds();
    scene.add(this.clouds);

    scene.add(this.sun, this.sun.target, this.fill, this.ambient);
    const s = this.sun.shadow;
    this.sun.castShadow = true;
    s.mapSize.set(2048, 2048);
    s.bias = -0.0003;
    s.normalBias = 0.02;

    scene.add(this.diorama);
    this.wetTargets.push(this.matPlaza, this.matGrass, this.matCurb);
  }

  /** window-glass materials from the kit — lit up by the night preset */
  setGlassMaterials(mats: MeshStandardMaterial[]): void {
    this.glassMats = mats;
    for (const m of mats) m.emissive = new Color(0xffc06a);
  }

  /** the snow-shell material from the kit — plaza/grass get shells too */
  setSnowShellMaterial(mat: Material): void {
    this.shellMaterial = mat;
  }

  private buildClouds(): void {
    const rnd = (i: number, k: number) => hash01(i * 17 + k, 91);
    for (let i = 0; i < 7; i++) {
      const cluster = new Group();
      const puffs = 3 + Math.floor(rnd(i, 0) * 3);
      for (let p = 0; p < puffs; p++) {
        const r = 3.2 + rnd(i, p + 1) * 3.4;
        const puff = new Mesh(new IcosahedronGeometry(r, 1), this.matCloud);
        puff.position.set((p - puffs / 2) * r * 0.95, rnd(i, p + 9) * 1.6, (rnd(i, p + 5) - 0.5) * 3.5);
        puff.scale.y = 0.55;
        cluster.add(puff);
      }
      const a = rnd(i, 30) * Math.PI * 2;
      const dist = 55 + rnd(i, 31) * 55;
      cluster.position.set(Math.cos(a) * dist, 20 + rnd(i, 32) * 16, Math.sin(a) * dist);
      cluster.rotation.y = rnd(i, 33) * Math.PI;
      this.clouds.add(cluster);
    }
  }

  private tree(kind: number): Group {
    const g = new Group();
    const trunkH = 0.7 + kind * 0.02;
    const trunk = new Mesh(new CylinderGeometry(0.09, 0.13, trunkH, 6), this.matTrunk);
    trunk.position.y = trunkH / 2;
    trunk.castShadow = true;
    g.add(trunk);
    const leaf = kind % 5 === 0 ? this.matBloom : kind % 2 ? this.matLeafA : this.matLeafB;
    let y = trunkH;
    for (let i = 0; i < 3; i++) {
      const r = 0.62 - i * 0.16;
      const puff = new Mesh(new IcosahedronGeometry(r, 1), leaf);
      puff.position.set(0, y + r * 0.6, 0);
      puff.rotation.y = i * 1.3 + kind;
      puff.castShadow = true;
      g.add(puff);
      y += r * 0.85;
    }
    return g;
  }

  private lamp(): Group {
    const g = new Group();
    const post = new Mesh(new CylinderGeometry(0.045, 0.06, 2.3, 6), this.matPost);
    post.position.y = 1.15;
    post.castShadow = true;
    g.add(post);
    const bulbMat = new MeshStandardMaterial({
      color: 0xfff2d8, roughness: 0.4,
      emissive: new Color(0xffc27d), emissiveIntensity: 0.35,
    });
    const bulb = new Mesh(new SphereGeometry(0.16, 12, 8), bulbMat);
    bulb.position.y = 2.42;
    bulb.userData.noSnow = true; // glowing glass — snow would look wrong and dim it
    g.add(bulb);
    const cap = new Mesh(new CylinderGeometry(0.2, 0.1, 0.12, 8), this.matPost);
    cap.position.y = 2.56;
    g.add(cap);
    const light = new PointLight(0xffc27d, 0, 11, 1.8);
    light.position.y = 2.4;
    g.add(light);
    this.lamps.push({ bulb: bulbMat, light });
    return g;
  }

  /** (re)build the pedestal + props sized to the building footprint */
  private buildDiorama(p: Footprint): void {
    const radius = Math.max(p.width, p.length) * 0.95 + 5.5;
    if (Math.abs(radius - this.builtRadius) < 0.01) return;
    this.builtRadius = radius;

    this.diorama.clear();
    this.lamps.length = 0;

    // pedestal: grass top cap, soil sides — a floating display base
    const body = new Mesh(
      new CylinderGeometry(radius, radius * 0.93, 2.0, 56),
      [this.matSoil, this.matGrass, this.matSoil],
    );
    body.position.y = -1.0;
    body.receiveShadow = true;
    this.diorama.add(body);

    // plaza slab + curb under the building footprint
    const sw = p.width + 3.2, sl = p.length + 3.2;
    const curb = new Mesh(new BoxGeometry(sw + 0.5, 0.1, sl + 0.5), this.matCurb);
    curb.position.y = 0.02;
    curb.receiveShadow = true;
    this.diorama.add(curb);
    const slab = new Mesh(new BoxGeometry(sw, 0.12, sl), this.matPlaza);
    slab.position.y = 0.05;
    slab.receiveShadow = true;
    this.diorama.add(slab);

    // soft contact shadow under the building
    const ao = new Mesh(
      new PlaneGeometry(Math.max(p.width, p.length) * 1.5, Math.max(p.width, p.length) * 1.5),
      new MeshStandardMaterial({ map: this.aoTex, transparent: true, roughness: 1, depthWrite: false }),
    );
    ao.rotation.x = -Math.PI / 2;
    ao.position.y = 0.115;
    ao.userData.noSnow = true; // transparent contact-shadow decal, not a surface
    this.diorama.add(ao);

    // trees + bushes on the outer grass ring (deterministic scatter, kept low so
    // they frame the building instead of hiding it)
    const treeCount = Math.round(radius * 1.15);
    for (let i = 0; i < treeCount; i++) {
      const a = (i / treeCount) * Math.PI * 2 + hash01(i, 7) * 0.45;
      const rr = radius * (0.74 + hash01(i, 8) * 0.18);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.abs(x) < sw / 2 + 0.8 && Math.abs(z) < sl / 2 + 0.8) continue; // keep off the plaza
      const t = this.tree(i);
      const sc = 0.85 + hash01(i, 9) * 0.55;
      t.scale.setScalar(sc);
      t.position.set(x, 0, z);
      t.rotation.y = hash01(i, 10) * Math.PI * 2;
      this.diorama.add(t);
      if (hash01(i, 11) > 0.55) {
        const bush = new Mesh(new IcosahedronGeometry(0.4 + hash01(i, 12) * 0.35, 1),
          hash01(i, 13) > 0.75 ? this.matBloom : this.matLeafA);
        bush.position.set(x + (hash01(i, 14) - 0.5) * 3, 0.28, z + (hash01(i, 15) - 0.5) * 3);
        bush.scale.y = 0.72;
        bush.castShadow = true;
        this.diorama.add(bush);
      }
    }

    // four street lamps at the plaza corners
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const l = this.lamp();
      l.position.set(sx * (sw / 2 + 0.9), 0, sz * (sl / 2 + 0.9));
      this.diorama.add(l);
    }

    // snow shell duplicates for EVERY diorama mesh (same principle as the
    // building: shared geometry, extruded by the snow shader, fragments off the
    // upward-facing accumulation mask discarded). Grass top, plaza, curb, tree
    // canopies, bushes, trunks and lamp posts all collect caps; the emissive
    // bulbs and the transparent contact-shadow decal opt out via userData.
    if (this.shellMaterial) {
      const shell = new Group();
      shell.name = "envSnowShell";
      shell.visible = this.snowShell?.visible ?? false;
      this.diorama.updateMatrixWorld(true);
      const targets: Mesh[] = [];
      this.diorama.traverse(o => {
        const m = o as Mesh;
        if (m.isMesh && !m.userData.noSnow) targets.push(m);
      });
      for (const src of targets) {
        const dup = new Mesh(src.geometry, this.shellMaterial);
        // props are nested in groups (tree/lamp roots carry position/scale/rotation),
        // so bake the full world transform into the duplicate
        dup.matrixAutoUpdate = false;
        dup.matrix.copy(src.matrixWorld);
        shell.add(dup);
      }
      this.diorama.add(shell);
      this.snowShell = shell;
    }

    this.applyPreset(this.preset, null);
  }

  /** fit diorama + shadow frustum to the current building */
  fit(p: Footprint): void {
    this.buildDiorama(p);
    const radius = this.builtRadius;
    const dist = radius * 2.6;
    const preset = PRESETS[this.preset];
    this.sun.position.copy(preset.sunDir).multiplyScalar(dist);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    const c = this.sun.shadow.camera;
    c.left = -radius * 1.15;
    c.right = radius * 1.15;
    c.top = radius * 1.15;
    c.bottom = -radius * 1.15;
    c.near = dist * 0.3;
    c.far = dist * 2.2;
    c.updateProjectionMatrix();
    this.fill.position.set(-radius * 2, radius * 1.4, -radius * 1.6);
  }

  applyPreset(name: PresetName, post: PostFX | null): void {
    this.preset = name;
    const p = PRESETS[name];

    const u = this.skyMat.uniforms;
    (u.uHorizon.value as Color).set(p.horizon);
    (u.uZenith.value as Color).set(p.zenith);
    (u.uHaze.value as Color).set(p.haze);
    (u.uSunDir.value as Vector3).copy(p.sunDir);
    (u.uSunColor.value as Color).set(p.sunColor);
    u.uNight.value = p.night;

    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.fill.color.set(p.fillColor);
    this.fill.intensity = p.fillIntensity;
    this.ambient.color.set(p.ambColor);
    this.ambient.intensity = p.ambIntensity;

    const fog = this.scene.fog as FogExp2;
    fog.color.set(p.fogColor);
    fog.density = p.fogDensity;

    this.matCloud.color.set(p.cloudColor);
    this.matCloud.emissive = new Color(p.cloudColor);
    this.matCloud.emissiveIntensity = p.cloudEmissive;

    for (const lamp of this.lamps) {
      lamp.light.intensity = p.lampIntensity;
      lamp.bulb.emissiveIntensity = p.lampEmissive;
    }
    for (const m of this.glassMats) m.emissiveIntensity = p.glassEmissive;

    this.renderer.toneMappingExposure = p.exposure;
    this.scene.environmentIntensity = p.envIntensity;

    if (post) {
      post.bloom.strength = p.bloom;
      post.bloom.threshold = p.bloomThreshold;
      post.gradeUniforms["uSaturation"].value = p.saturation;
      post.gradeUniforms["uContrast"].value = p.contrast;
      post.gradeUniforms["uVignette"].value = p.vignette;
    }

    // re-aim the sun for the new direction
    if (this.builtRadius > 0) {
      this.sun.position.copy(p.sunDir).multiplyScalar(this.builtRadius * 2.6);
    }
  }

  setCloudsVisible(v: boolean): void {
    this.clouds.visible = v;
  }

  /** slow cloud drift + star twinkle */
  tick(dt: number): void {
    this.clouds.rotation.y += dt * 0.006;
    this.skyMat.uniforms.uTime.value += dt;
  }

  /** camera framing helper — sits outside the pedestal, looking over the trees */
  cameraHome(p: Footprint, camera: PerspectiveCamera): { pos: Vector3; target: Vector3 } {
    void camera;
    const radius = Math.max(0.7 * Math.hypot(p.width, p.length, p.height), this.builtRadius * 0.85);
    return {
      pos: new Vector3(radius * 1.95, radius * 0.95, radius * 2.25),
      target: new Vector3(0, (p.height - 0.4) / 2 + 0.5, 0),
    };
  }
}
