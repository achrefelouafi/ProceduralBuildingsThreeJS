/**
 * The NYC module kit (public/assets/nyc/kit.json + kit.bin, written by
 * tools/nyc/export_nyc_kit.py): local-space evaluated meshes of every module
 * object, Collection Info child orders, and the String to Curves glyphs.
 */
import { Mesh } from "./geo";
import type { FontData, KitSource } from "./gn";

type Span = [number, number]; // byte offset, element count

interface KitObject {
  pos: Span; faceStart: Span; corners: Span; matIndex: Span; smooth: Span; cornerNormals: Span;
  uv?: Span;
  materials: (string | null)[];
  attrs: Record<string, { domain: "point" | "face"; size: 1 | 3; data: Span }>;
}
export interface KitJson {
  objects: Record<string, KitObject>;
  collections: Record<string, string[]>;
  font: FontData;
}

export class NycKit implements KitSource {
  private meshes = new Map<string, Mesh>();
  /** per module object: corner normals (Blender's split normals) for shading */
  readonly cornerNormals = new Map<Mesh, Float32Array>();
  readonly cornerUVs = new Map<Mesh, Float32Array>();
  readonly font: FontData;

  constructor(private json: KitJson, private bin: ArrayBuffer) {
    this.font = json.font;
  }

  private f32(s: Span): Float32Array { return new Float32Array(this.bin, s[0], s[1]); }
  private i32(s: Span): Int32Array { return new Int32Array(this.bin, s[0], s[1]); }

  object(name: string): Mesh {
    let m = this.meshes.get(name);
    if (m) return m;
    const o = this.json.objects[name];
    if (!o) throw new Error(`nyc kit: missing object ${name}`);
    m = new Mesh(this.f32(o.pos), [], o.materials);
    m.faceStart = this.i32(o.faceStart).slice();
    m.corners = this.i32(o.corners).slice();
    m.matIndex = this.i32(o.matIndex).slice();
    m.smooth = Uint8Array.from(this.i32(o.smooth));
    for (const [k, a] of Object.entries(o.attrs)) (a.domain === "face" ? m.face : m.point).set(k, { size: a.size, data: this.f32(a.data).slice() });
    m.source = name;
    this.cornerNormals.set(m, this.f32(o.cornerNormals));
    if (o.uv) this.cornerUVs.set(m, this.f32(o.uv));
    this.meshes.set(name, m);
    return m;
  }

  collection(name: string): string[] {
    const c = this.json.collections[name];
    if (!c) throw new Error(`nyc kit: missing collection ${name}`);
    return c;
  }
}
