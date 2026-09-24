/**
 * Cinematic post stack:
 *   Render → GTAO (ambient occlusion) → Depth of Field → Bloom
 *          → tone map / sRGB (OutputPass) → Film grade
 *
 * - GTAO restores the contact shadowing the .blend materials got from their
 *   Ambient Occlusion nodes. Glass, curtains, particles, the backdrop and the
 *   volumetric beam are hidden from it (userData.noAO) so they don't cast AO.
 * - DoF is a Bokeh pass whose focus distance can track the orbit target.
 * - The grade runs in display space: white balance, split toning (shadow /
 *   highlight tints), contrast, saturation, radial chromatic aberration,
 *   vignette, animated grain, and letterbox bars (animated, any aspect).
 */
import {
  Color, HalfFloatType, Object3D, PerspectiveCamera, Scene, Vector2, WebGLRenderer, WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.03 },
    uChroma: { value: 0.0018 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.0 },
    uTemperature: { value: 0 },
    uShadowTint: { value: new Color(0x1b2a3a) },
    uHighlightTint: { value: new Color(0xffe2c0) },
    uSplitTone: { value: 0.25 },
    uBars: { value: 0 }, // letterbox bar height, fraction of the frame per bar
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uChroma, uContrast, uSaturation, uTemperature, uSplitTone, uBars;
    uniform vec3 uShadowTint, uHighlightTint;
    varying vec2 vUv;

    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 dir = vUv - 0.5;

      // radial chromatic aberration — stronger toward the frame edges
      float ca = uChroma * dot(dir, dir) * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - dir * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + dir * ca).b;

      // white balance: warm (+) / cool (−)
      col *= vec3(1.0 + uTemperature * 0.35, 1.0 + uTemperature * 0.05, 1.0 - uTemperature * 0.4);

      // split toning: tint shadows and highlights separately, keep luminance
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 toned = mix(uShadowTint, uHighlightTint, smoothstep(0.05, 0.75, luma));
      vec3 tonedCol = col * toned / max(dot(toned, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      col = mix(col, tonedCol, uSplitTone);

      // contrast (around mid grey) + saturation
      col = (col - 0.5) * uContrast + 0.5;
      luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // vignette (aspect-aware, soft)
      float vig = smoothstep(0.35, 0.95, length(dir * vec2(1.0, 0.8)) * 1.25);
      col *= 1.0 - vig * uVignette;

      // animated film grain, weighted to the mid-tones
      float g = rand(vUv * 1.7 + fract(uTime * 7.13)) - 0.5;
      col += g * uGrain * (0.4 + 0.6 * (1.0 - abs(luma - 0.5) * 2.0));

      // letterbox
      float bar = step(vUv.y, uBars) + step(1.0 - uBars, vUv.y);
      col = mix(col, vec3(0.0), bar);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

type UniformMap = Record<string, { value: number }>;

/** GTAO that skips objects flagged userData.noAO (transparent / additive / backdrop) */
class SelectiveGTAOPass extends GTAOPass {
  private hidden: Object3D[] = [];
  override render(...args: Parameters<GTAOPass["render"]>): void {
    this.scene.traverse(o => {
      if (o.userData.noAO && o.visible) {
        o.visible = false;
        this.hidden.push(o);
      }
    });
    super.render(...args);
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
  }
}

export const LETTERBOX = { off: 0, "1.85 : 1": 1.85, "2.39 : 1": 2.39, "2.76 : 1": 2.76 } as const;
export type Letterbox = keyof typeof LETTERBOX;

export class PostFX {
  readonly composer: EffectComposer;
  readonly ao: SelectiveGTAOPass;
  readonly bokeh: BokehPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  /** letterbox target aspect (0 = off), eased in/out */
  letterbox = 0;
  private bars = 0;
  private size = new Vector2();

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    // a page opened in a hidden tab reports 0×0 — passes built at zero size never
    // recover (bloom mips), so start from a sane size; setSize() corrects it
    if (!size.x || !size.y) size.set(1280, 720);
    // multisampled HDR target keeps edges clean through the stack
    const rt = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = new SelectiveGTAOPass(scene, camera, size.x, size.y);
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.5, scale: 1.0, samples: 16 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.composer.addPass(this.ao);

    this.bokeh = new BokehPass(scene, camera, { focus: 40, aperture: 0.0008, maxblur: 0.008 });
    this.bokeh.enabled = false;
    this.composer.addPass(this.bokeh);

    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), 0.3, 0.6, 0.85);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass()); // tone mapping + sRGB

    this.grade = new ShaderPass(FilmGradeShader);
    this.composer.addPass(this.grade); // last → display space
  }

  get bokehUniforms(): UniformMap {
    return this.bokeh.uniforms as unknown as UniformMap;
  }

  get gradeUniforms(): UniformMap {
    return this.grade.uniforms as unknown as UniformMap;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  render(dt: number): void {
    const g = this.gradeUniforms;
    g.uTime.value += dt;
    // letterbox bars for the target aspect, eased
    this.composer.renderer.getDrawingBufferSize(this.size);
    const aspect = this.size.y > 0 ? this.size.x / this.size.y : 1;
    const target = this.letterbox > 0 ? Math.max(0, (1 - aspect / this.letterbox) / 2) : 0;
    this.bars += (target - this.bars) * Math.min(1, dt * 4);
    if (!Number.isFinite(this.bars)) this.bars = target;
    g.uBars.value = this.bars;
    this.composer.render();
  }
}
