/**
 * The New York corner building: NYC_CornerBuilding.blend's NYC_Building
 * geometry-nodes modifier, evaluated live from its dumped graph (gn.ts) and
 * drawn with its compiled materials (shadergraph.ts). Every modifier input is
 * a parameter here, with the .blend's current values as defaults.
 */
import type { Group, Material } from "three";
import { Evaluator, type GIface, type GraphJson } from "./gn";
import { NycKit, type KitJson } from "./kit";
import { leaves } from "./flatten";
import { buildNycGroup } from "./render";
import { compileMaterial, type MaterialsJson, type NycMaterial } from "./shadergraph";

export interface NycInput {
  name: string;
  panel: string;
  type: "float" | "int" | "bool" | "menu" | "string";
  min?: number;
  max?: number;
  subtype?: string;
  description?: string;
  options?: string[];
}

export class NycBuilding {
  readonly params: Record<string, number | boolean | string> = {};
  readonly inputs: NycInput[] = [];
  readonly materials = new Map<string, NycMaterial>();
  private graph!: GraphJson;
  private kit!: NycKit;

  static async load(base: string): Promise<NycBuilding> {
    const b = new NycBuilding();
    const get = (f: string) => fetch(`${base}nyc/${f}`).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
    const [graph, kitJson, bin, mats] = await Promise.all([
      get("graph.json").then(r => r.json() as Promise<GraphJson>),
      get("kit.json").then(r => r.json() as Promise<KitJson>),
      get("kit.bin").then(r => r.arrayBuffer()),
      get("materials.json").then(r => r.json() as Promise<MaterialsJson>),
    ]);
    b.graph = graph;
    b.kit = new NycKit(kitJson, bin);
    await Promise.all(Object.entries(mats.materials).map(async ([name, g]) => {
      b.materials.set(name, await compileMaterial(name, g, mats, base));
    }));
    b.describe();
    return b;
  }

  /** the NYC_Building interface → GUI inputs; defaults = the .blend modifier values */
  private describe(): void {
    const tree = this.graph.trees.find(t => t.name === this.graph.root)!;
    const gi = tree.nodes.find(n => n.type === "NodeGroupInput")!;
    const menus = new Map<string, string[]>();
    for (const l of tree.links) {
      const to = tree.nodes.find(n => n.name === l.to);
      if (l.from === gi.name && to?.type === "GeometryNodeMenuSwitch" && l.ti === 0) menus.set(gi.outputs[l.fi].name, to.menu ?? []);
    }
    for (const it of tree.interface as GIface[]) {
      if (it.item_type !== "SOCKET" || it.in_out !== "INPUT") continue;
      const st = it.socket_type;
      const type = st === "NodeSocketFloat" ? "float" : st === "NodeSocketInt" ? "int" : st === "NodeSocketBool" ? "bool"
        : st === "NodeSocketMenu" ? "menu" : st === "NodeSocketString" ? "string" : null;
      if (!type) continue;
      const inp: NycInput = { name: it.name, panel: it.parent ?? "", type, min: it.min_value, max: it.max_value,
        subtype: it.subtype, description: it.description, options: menus.get(it.name) };
      this.inputs.push(inp);
      const v = this.graph.modifier[it.name] ?? it.default_value;
      this.params[it.name] = type === "bool" ? !!v : type === "menu" || type === "string" ? String(v ?? inp.options?.[0] ?? "") : Number(v);
    }
  }

  defaults(): Record<string, number | boolean | string> {
    const d: Record<string, number | boolean | string> = {};
    for (const i of this.inputs) {
      const v = this.graph.modifier[i.name];
      d[i.name] = i.type === "bool" ? !!v : i.type === "menu" || i.type === "string" ? String(v) : Number(v);
    }
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

  /** Blender-space point that goes to the stage centre */
  center(): { x: number; y: number } {
    const f = this.footprint();
    return { x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2 };
  }

  size(): { width: number; length: number; height: number } {
    const f = this.footprint();
    return { width: f.maxX - f.minX, length: f.maxY - f.minY, height: this.wallTop() + Number(this.params["Cornice Height"]) + 3 };
  }

  get hasSidewalk(): boolean { return !!this.params["Sidewalk"]; }
}
