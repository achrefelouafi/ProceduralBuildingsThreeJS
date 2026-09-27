/**
 * The Chinese corner apartment building: CN_ApartmentBuilding.blend's
 * CN_Building geometry-nodes modifier (on CN_CornerApartment), evaluated live
 * from its dumped graph by the same evaluator as the New York building
 * (src/nyc/gn.ts). Assets: public/assets/cn/ (tools/cn/*.py).
 *
 * The graph realizes everything into one mesh and CN_Finalize box-projects
 * UVs per material and tints the Col color attribute, so the building draws as
 * one merged mesh per material with UV-mapped PBR textures.
 */
import { GraphBuilding } from "../nyc/building";
import type { StageSides } from "../studio";

export class CnBuilding extends GraphBuilding {
  constructor() { super("cn"); }

  static load(base: string): Promise<CnBuilding> { return new CnBuilding().load(base); }

  /** the footprint spans x ∈ [0, Width], y ∈ [0, Depth] (the corner at the origin) */
  center(): { x: number; y: number } {
    return { x: Number(this.params["Width"]) / 2, y: Number(this.params["Depth"]) / 2 };
  }

  size(): { width: number; length: number; height: number } {
    const p = this.params;
    const walls = Number(p["Ground Floor Height"]) + (Number(p["Floors"]) - 1) * Number(p["Floor Height"]);
    const top = Number(p["Parapet Height"]) + (p["Rooftop Sign"] ? Number(p["Sign Height"]) + 1 : 2.5);
    return { width: Number(p["Width"]), length: Number(p["Depth"]), height: walls + top };
  }

  /** all the way round */
  sidewalk(): { width: number; sides: StageSides } | null {
    if (!this.params["Sidewalk"]) return null;
    return { width: Number(this.params["Sidewalk Width"]), sides: { front: true, left: true, back: true, right: true } };
  }
}
