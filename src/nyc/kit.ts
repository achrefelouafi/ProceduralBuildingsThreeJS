/**
 * A graph building's module kit (public/assets/<nyc|cn>/kit.json + kit.bin,
 * written by tools/nyc/export_nyc_kit.py / tools/cn/export_cn_kit.py):
 * local-space evaluated meshes of every module object, Collection Info child
 * orders, and the String to Curves glyphs.
 */
import { Mesh, type AttrSize } from "./geo";
import type { FontData, GlyphData, KitSource } from "./gn";

type Span = [number, number]; // byte offset, element count

interface KitObject {
  pos: Span; faceStart: Span; corners: Span; matIndex: Span; smooth: Span;
  /** Blender's split normals (NYC kit; the CN kit's final mesh recomputes them) */
  cornerNormals?: Span;
  uv?: Span;
  materials: (string | null)[];
  attrs: Record<string, { domain: "point" | "face" | "corner"; size: AttrSize; data: Span }>;
}
/**
 * glyph outlines inline (NYC) or as x, y float spans in kit.bin (CN), with
 * Blender's Fill Curve triangles (uint16 indices, optional own vertices)
 */
type KitGlyph = GlyphData | { advance: number; spans: Span[]; fill?: Span; fillPos?: Span };
export interface KitJson {
  objects: Record<string, KitObject>;
  collections: Record<string, string[]>;
  font: { space: number; glyphs: Record<string, KitGlyph> };
}

export class NycKit implements KitSource {
  private meshes = new Map<string, Mesh>();
  /** per module object: corner normals (Blender's split normals) for shading */
  readonly cornerNormals = new Map<Mesh, Float32Array>();
  readonly cornerUVs = new Map<Mesh, Float32Array>();
  readonly font: FontData;

  constructor(private json: KitJson, private bin: ArrayBuffer) {
    const glyphs: Record<string, GlyphData> = {};
    for (const [ch, g] of Object.entries(json.font.glyphs)) {
      glyphs[ch] = "spans" in g ? {
        advance: g.advance, loops: g.spans.map(s => Array.from(this.f32(s))),
        fill: g.fill && new Uint16Array(this.bin, g.fill[0], g.fill[1]), fillPos: g.fillPos && this.f32(g.fillPos),
      } : g;
    }
    this.font = { space: json.font.space, glyphs };
  }

  private f32(s: Span): Float32Array { return new Float32Array(this.bin, s[0], s[1]); }
  private i32(s: Span): Int32Array { return new Int32Array(this.bin, s[0], s[1]); }

  object(name: string): Mesh {
    let m = this.meshes.get(name);
    if (m) return m;
    const o = this.json.objects[name];
    if (!o) throw new Error(`kit: missing object ${name}`);
    m = new Mesh(this.f32(o.pos), [], o.materials);
    m.faceStart = this.i32(o.faceStart).slice();
    m.corners = this.i32(o.corners).slice();
    m.matIndex = this.i32(o.matIndex).slice();
    m.smooth = Uint8Array.from(this.i32(o.smooth));
    for (const [k, a] of Object.entries(o.attrs)) {
      const map = a.domain === "face" ? m.face : a.domain === "corner" ? m.corner : m.point;
      map.set(k, { size: a.size, data: this.f32(a.data).slice() });
    }
    m.source = name;
    if (o.cornerNormals) this.cornerNormals.set(m, this.f32(o.cornerNormals));
    if (o.uv) this.cornerUVs.set(m, this.f32(o.uv));
    this.meshes.set(name, m);
    return m;
  }

  collection(name: string): string[] {
    const c = this.json.collections[name];
    if (!c) throw new Error(`kit: missing collection ${name}`);
    return c;
  }
}
