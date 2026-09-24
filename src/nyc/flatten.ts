/**
 * Flatten an evaluated Geo into the pieces a renderer draws: every mesh at
 * every nesting level with its world matrix and the instance attributes it
 * inherits (nearest level first) — the same leaves Blender's depsgraph yields.
 */
import { Geo, identity, mul, type Mat4, type Mesh } from "./geo";

export interface Leaf {
  mesh: Mesh;
  matrix: Mat4;
  /** instance attributes seen from this leaf, nearest instance level wins */
  attrs: Map<string, number[]>;
}

export function leaves(g: Geo): Leaf[] {
  const out: Leaf[] = [];
  const walk = (geo: Geo, m: Mat4, attrs: Map<string, number[]>) => {
    if (geo.mesh && geo.mesh.points && geo.mesh.faces) out.push({ mesh: geo.mesh, matrix: m, attrs });
    const inst = geo.instances;
    if (!inst) return;
    for (let i = 0; i < inst.count; i++) {
      const a = new Map(attrs);
      for (const [k, v] of inst.inst) a.set(k, Array.from(v.data.subarray(i * v.size, i * v.size + v.size)));
      walk(inst.refs[inst.handle[i]], mul(m, inst.mats[i]), a);
    }
  };
  walk(g, identity(), new Map());
  return out;
}

export function signature(m: Mesh): string {
  const mats = [...new Set(m.materials.filter((x): x is string => !!x))].sort();
  return `${m.points}/${m.faces}/${mats.join(",") || "-"}`;
}
