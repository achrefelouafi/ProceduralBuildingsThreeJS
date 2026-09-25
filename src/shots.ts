/**
 * Camera shots for the lighting set — framed from the live building size and
 * flown to with an eased dolly (position, target and focal length together).
 * Azimuth 0° looks at the front facade (+Z, where the door is).
 */
import { MathUtils, PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { StageBounds } from "./studio";

export type Shot = "Hero ¾" | "Street level" | "Worm's-eye" | "Aerial" | "Facade detail" | "Profile";
export const SHOTS: Shot[] = ["Hero ¾", "Street level", "Worm's-eye", "Aerial", "Facade detail", "Profile"];

interface Framing {
  pos: Vector3;
  target: Vector3;
  fov: number;
}

const rad = MathUtils.degToRad;

/** camera on a sphere around `target` at azimuth/elevation, distance fitted to radius at fov */
function orbitFrame(target: Vector3, radius: number, az: number, el: number, fov: number, fit: number): Framing {
  const dist = (radius / Math.sin(rad(fov) / 2)) * fit;
  const pos = new Vector3(
    Math.sin(rad(az)) * Math.cos(rad(el)),
    Math.sin(rad(el)),
    Math.cos(rad(az)) * Math.cos(rad(el)),
  ).multiplyScalar(dist).add(target);
  return { pos, target, fov };
}

/**
 * `visible` is the fraction of the frame height left between letterbox bars:
 * orbit shots back off so the building still fits inside the picture area.
 */
export function frameShot(shot: Shot, b: StageBounds, visible = 1): Framing {
  const hw = b.width / 2, hl = b.length / 2, h = b.height;
  const r = (0.5 * Math.hypot(b.width, b.length, h)) / Math.max(visible, 0.4);
  switch (shot) {
    case "Hero ¾":
      return orbitFrame(new Vector3(0, h * 0.42, 0), r, 34, 9, 32, 0.95);
    case "Street level": {
      // eye height, far enough back that the whole elevation fits looking up
      const back = hl + (h * 0.62) / Math.tan(rad(21) * Math.min(visible, 1)) + 4;
      return { pos: new Vector3(hw * 0.35, 1.7, back), target: new Vector3(0, h * 0.5, 0), fov: 42 };
    }
    case "Worm's-eye":
      return { pos: new Vector3(hw + 4, 0.7, hl + 4), target: new Vector3(-hw * 0.2, h * 0.85, -hl * 0.2), fov: 62 };
    case "Aerial":
      return orbitFrame(new Vector3(0, h * 0.3, 0), r, 28, 48, 30, 1.0);
    case "Facade detail":
      // the étage noble balcony (2nd floor) on the front, slightly off-axis
      return { pos: new Vector3(hw * 0.25 + 3, 9.5, hl + 10), target: new Vector3(hw * 0.1, 8.2, hl), fov: 30 };
    case "Profile":
      return orbitFrame(new Vector3(0, h * 0.45, 0), r, 90, 3, 22, 1.08);
  }
}

/** eased camera move between framings */
export class ShotDirector {
  private from: Framing | null = null;
  private to: Framing | null = null;
  private t = 0;
  private duration = 2.4;

  constructor(private camera: PerspectiveCamera, private controls: OrbitControls) {}

  get moving(): boolean {
    return this.to !== null;
  }

  go(f: Framing, seconds = 2.4): void {
    if (![f.pos.x, f.pos.y, f.pos.z, f.target.x, f.target.y, f.target.z, f.fov].every(Number.isFinite)) return;
    if (seconds <= 0) {
      this.stop(); // an instant cut also cancels a move in flight
      this.set(f);
      return;
    }
    this.from = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.to = f;
    this.t = 0;
    this.duration = seconds;
  }

  /** cancel a move (e.g. the user grabbed the camera) */
  stop(): void {
    this.to = null;
  }

  private set(f: Framing): void {
    this.camera.position.copy(f.pos);
    this.controls.target.copy(f.target);
    this.camera.fov = f.fov;
    this.camera.updateProjectionMatrix();
  }

  tick(dt: number): void {
    if (!this.to || !this.from) return;
    this.t = Math.min(this.t + dt / this.duration, 1);
    const e = this.t * this.t * this.t * (this.t * (this.t * 6 - 15) + 10); // smootherstep
    this.camera.position.lerpVectors(this.from.pos, this.to.pos, e);
    this.controls.target.lerpVectors(this.from.target, this.to.target, e);
    this.camera.fov = this.from.fov + (this.to.fov - this.from.fov) * e;
    this.camera.updateProjectionMatrix();
    if (this.t >= 1) this.to = null;
  }
}
