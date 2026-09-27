/**
 * A building evaluated live from a dumped Blender geometry-nodes graph
 * (gn.ts) and drawn with its compiled materials (shadergraph.ts). Every
 * modifier input is a parameter, with the .blend's current values as
 * defaults. GraphBuilding holds what the buildings share; each subclass knows
 * its footprint:
 *  - NycBuilding: NYC_CornerBuilding.blend's NYC_Building (public/assets/nyc/),
 *  - CnBuilding (src/cn/building.ts): CN_ApartmentBuilding.blend's CN_Building
 *    (public/assets/cn/).
 */
import type { Group, Material } from "three";
import { Evaluator, type GIface, type GraphJson } from "./gn";
import { NycKit, type KitJson } from "./kit";
import { leaves } from "./flatten";
import { buildNycGroup } from "./render";
import { compileMaterial, type MaterialsJson, type NycMaterial } from "./shadergraph";
import type { StageSides } from "../studio";

export interface NycInput {
  name: string;
  panel: string;
  type: "float" | "int" | "bool" | "menu" | "string" | "color";
  min?: number;
  max?: number;
  subtype?: string;
  description?: string;
  options?: string[];
}

export type ParamValue = number | boolean | string | number[];

/** the shortest decimal with the same float32 value (4.19999980926… → 4.2), for display */
function shortestF32(x: number): number {
  for (let p = 1; p < 10; p++) {
    const y = Number(x.toPrecision(p));
    if (Math.fround(y) === Math.fround(x)) return y;
  }
  return x;
}

export abstract class GraphBuilding {
  readonly params: Record<string, ParamValue> = {};
  readonly inputs: NycInput[] = [];
  readonly materials = new Map<string, NycMaterial>();
  protected graph!: GraphJson;
  protected kit!: NycKit;

  /** dir: the asset folder under public/assets/ */
  constructor(readonly dir: string) {}

  /** fetch the graph, kit and materials, compile the materials, read the interface */
  protected async load(base: string): Promise<this> {
    const root = `${base}${this.dir}/`;
    const get = (f: string) => fetch(root + f).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
    const [graph, kitJson, bin, mats] = await Promise.all([
      get("graph.json").then(r => r.json() as Promise<GraphJson>),
      get("kit.json").then(r => r.json() as Promise<KitJson>),
      get("kit.bin").then(r => r.arrayBuffer()),
      get("materials.json").then(r => r.json() as Promise<MaterialsJson>),
    ]);
    this.graph = graph;
    this.kit = new NycKit(kitJson, bin);
    await Promise.all(Object.entries(mats.materials).map(async ([name, g]) => {
      this.materials.set(name, await compileMaterial(name, g, mats, `${root}tex/`));
    }));
    this.describe();
    return this;
  }

  /** the root group's interface → GUI inputs; defaults = the .blend modifier values */
  private describe(): void {
    const tree = this.graph.trees.find(t => t.name === this.graph.root)!;
    const gi = tree.nodes.find(n => n.type === "NodeGroupInput")!;
    const menus = new Map<string, string[]>();
    for (const l of tree.links) {
      const to = tree.nodes.find(n => n.name === l.to);
      if (l.from === gi.name && to?.type === "GeometryNodeMenuSwitch" && l.ti === 0) menus.set(gi.outputs[l.fi].name, to.menu ?? []);
    }
    const types: Record<string, NycInput["type"]> = {
      NodeSocketFloat: "float", NodeSocketInt: "int", NodeSocketBool: "bool", NodeSocketMenu: "menu",
      NodeSocketString: "string", NodeSocketColor: "color",
    };
    for (const it of tree.interface as GIface[]) {
      if (it.item_type !== "SOCKET" || it.in_out !== "INPUT") continue;
      const type = types[it.socket_type ?? ""];
      if (!type) continue;
      const inp: NycInput = { name: it.name, panel: it.parent ?? "", type, min: it.min_value, max: it.max_value,
        subtype: it.subtype, description: it.description, options: menus.get(it.name) };
      this.inputs.push(inp);
      this.params[it.name] = this.value(inp, this.graph.modifier[it.name] ?? it.default_value);
    }
  }

  private value(i: NycInput, v: unknown): ParamValue {
    if (i.type === "bool") return !!v;
    if (i.type === "menu" || i.type === "string") return String(v ?? i.options?.[0] ?? "");
    if (i.type === "color") return Array.isArray(v) ? v.map(Number) : [1, 1, 1, 1];
    return i.type === "float" ? shortestF32(Number(v)) : Number(v);
  }

  defaults(): Record<string, ParamValue> {
    const d: Record<string, ParamValue> = {};
    for (const i of this.inputs) d[i.name] = this.value(i, this.graph.modifier[i.name]);
    return d;
  }

  /** evaluate + draw; returns the Blender-space group (not yet positioned) */
  build(snowShellMaterial: Material | null): Group {
    const ev = new Evaluator(this.graph, this.kit);
    const geo = ev.run(this.graph.root, this.params);
    return buildNycGroup(leaves(geo), {
      materials: this.materials,
      cornerNormals: m => this.kit.cornerNormals.get(m),
      snowShellMaterial,
    });
  }

  /** Blender-space point that goes to the stage centre */
  abstract center(): { x: number; y: number };
  /** stage / shot bounds */
  abstract size(): { width: number; length: number; height: number };
  /**
   * the building's own sidewalk + curb, if it brings one: how far its curb face
   * reaches past the footprint, and the stage sides it runs along (the stage
   * paves the rest; its streets start at the curb)
   */
  abstract sidewalk(): { width: number; sides: StageSides } | null;
}

/** NYC_CornerBuilding.blend's NYC_Building modifier */
export class NycBuilding extends GraphBuilding {
  constructor() { super("nyc"); }

  static load(base: string): Promise<NycBuilding> { return new NycBuilding().load(base); }

  /** wall height to the cornice (NYC_Building's Htop) */
  private wallTop(): number {
    const p = this.params;
    const gh = Number(p["Ground Floor Height"]), H = Number(p["Building Height"]);
    const up = Math.max(Number(p["Floor Count"]) - 1, 1);
    const fh = H > gh ? (H - gh) / up : Number(p["Floor Height"]);
    return gh + up * fh;
  }

  /** footprint parallelogram (facade A along +X, facade B at the corner angle) */
  private footprint(): { minX: number; maxX: number; minY: number; maxY: number } {
    const p = this.params;
    const W = Number(p["Building Width"]), D = Number(p["Building Depth"]), th = Number(p["Corner Angle"]);
    const pts = [[0, 0], [W, 0], [D * Math.cos(th), D * Math.sin(th)], [W + D * Math.cos(th), D * Math.sin(th)]];
    return {
      minX: Math.min(...pts.map(q => q[0])), maxX: Math.max(...pts.map(q => q[0])),
      minY: Math.min(...pts.map(q => q[1])), maxY: Math.max(...pts.map(q => q[1])),
    };
  }

  center(): { x: number; y: number } {
    const f = this.footprint();
    return { x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2 };
  }

  size(): { width: number; length: number; height: number } {
    const f = this.footprint();
    return { width: f.maxX - f.minX, length: f.maxY - f.minY, height: this.wallTop() + Number(this.params["Cornice Height"]) + 3 };
  }

  /** all the way round, or along the two street facades only: A (front, +Z) and B (left, −X) */
  sidewalk(): { width: number; sides: StageSides } | null {
    if (!this.params["Sidewalk"]) return null;
    const all = this.params["Sidewalk All Around"] !== false;
    return { width: Number(this.params["Sidewalk Width"]), sides: { front: true, left: true, back: all, right: all } };
  }
}
