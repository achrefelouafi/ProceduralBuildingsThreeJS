/**
 * The French building's own sidewalk and granite curb: FrenchBuilding.blend's
 * FR_Sidewalk and FR_Curb (tools/export_fr_street.py → public/assets/fr/),
 * drawn with their compiled Blender materials by the graph renderer
 * (src/nyc/render.ts, src/nyc/shadergraph.ts).
 *
 * Both carry the FR_SidewalkFollowBuilding modifier, ported here: the meshes
 * are modelled around a Modeled Width × Depth building, and every point past
 * its half width / depth slides with the far walls of the real one
 * (Bays × Bay Width + Corner Extra). The modifier also stores the modelled
 * position as "rest", which the pavement's grime band along the curb reads.
 */
import type { Group, Material } from "three";
import { identity, type Mesh } from "./nyc/geo";
import { NycKit, type KitJson } from "./nyc/kit";
import { buildNycGroup } from "./nyc/render";
import { compileMaterial, type MaterialsJson, type NycMaterial } from "./nyc/shadergraph";

interface StreetJson extends KitJson {
  /** FR_SidewalkFollowBuilding's constant inputs */
  follow: { "Bay Width": number; "Corner Extra": number; "Modeled Width": number; "Modeled Depth": number };
}

const OBJECTS = ["FR_Sidewalk", "FR_Curb"];

export class FrenchStreet {
  readonly materials = new Map<string, NycMaterial>();
  /** how far the curb face reaches past the footprint (where the city's streets start) */
  readonly reach: number;

  private constructor(private json: StreetJson, private kit: NycKit) {
    const curb = kit.object("FR_Curb").pos;
    let minX = Infinity;
    for (let i = 0; i < curb.length; i += 3) minX = Math.min(minX, curb[i]);
    this.reach = -minX; // the modelled building starts at x = 0
  }

  static async load(base: string): Promise<FrenchStreet> {
    const root = `${base}fr/`;
    const get = (f: string) => fetch(root + f).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
    const [json, bin, mats] = await Promise.all([
      get("street.json").then(r => r.json() as Promise<StreetJson>),
      get("street.bin").then(r => r.arrayBuffer()),
      get("materials.json").then(r => r.json() as Promise<MaterialsJson>),
    ]);
    const street = new FrenchStreet(json, new NycKit(json, bin));
    await Promise.all(Object.entries(mats.materials).map(async ([name, g]) => {
      street.materials.set(name, await compileMaterial(name, g, mats, `${root}tex/`));
    }));
    return street;
  }

  /** the sidewalk + curb around a Bays X × Bays Y building (Blender space: the footprint spans x ∈ [0, W], y ∈ [0, L]) */
  build(baysX: number, baysY: number, snowShellMaterial: Material | null): Group {
    const f = this.json.follow;
    const hx = f["Modeled Width"] * 0.5, hy = f["Modeled Depth"] * 0.5;
    const dx = baysX * f["Bay Width"] + f["Corner Extra"] - f["Modeled Width"];
    const dy = baysY * f["Bay Width"] + f["Corner Extra"] - f["Modeled Depth"];
    const normals = new Map<Mesh, Float32Array>();
    const leaves = OBJECTS.map(name => {
      const src = this.kit.object(name);
      const m = src.clone();
      m.point.set("rest", { size: 3, data: src.pos.slice() });
      for (let i = 0; i < m.pos.length; i += 3) {
        if (m.pos[i] > hx) m.pos[i] += dx;
        if (m.pos[i + 1] > hy) m.pos[i + 1] += dy;
      }
      const n = this.kit.cornerNormals.get(src);
      if (n) normals.set(m, n); // a slide along the walls leaves every face's normal as it was
      return { mesh: m, matrix: identity(), attrs: new Map<string, number[]>() };
    });
    const g = buildNycGroup(leaves, { materials: this.materials, cornerNormals: m => normals.get(m), snowShellMaterial });
    g.name = "frStreet";
    return g;
  }
}
