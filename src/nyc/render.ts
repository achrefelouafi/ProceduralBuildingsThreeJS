/**
 * Draws an evaluated NYC building: every leaf mesh (flatten.ts) grouped by
 * mesh identity into one InstancedMesh per material slot, with the instance
 * attributes the material reads as InstancedBufferAttributes (ai_<name>) and
 * the mesh's own point / face attributes as vertex attributes (ag_<name>).
 * Kit meshes shade with Blender's exported corner normals; generated meshes
 * flat or smooth per face like Blender.
 */
import {
  BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh as TMesh,
  MeshStandardMaterial, type Material,
} from "three";
import type { Mesh } from "./geo";
import type { Leaf } from "./flatten";
import type { NycMaterial } from "./shadergraph";

const fallback = new MeshStandardMaterial({ name: "NYC_none", color: 0x9a9a9a, roughness: 0.8 });

interface SlotGeo { geo: BufferGeometry; corners: number[]; faces: number[] }

/** triangulated per-slot geometry of one mesh (fan triangulation, corner-expanded) */
function slotGeometries(m: Mesh, cornerNormals: Float32Array | undefined): Map<number, SlotGeo> {
  const out = new Map<number, { pos: number[]; nrm: number[]; corners: number[]; faces: number[] }>();
  const vn = cornerNormals ? null : m.vertexNormals();
  for (let f = 0; f < m.faces; f++) {
    const slot = m.materials.length ? m.matIndex[f] : 0;
    let s = out.get(slot);
    if (!s) out.set(slot, (s = { pos: [], nrm: [], corners: [], faces: [] }));
    const a = m.faceStart[f], n = m.faceStart[f + 1] - a;
    const fn = cornerNormals ? null : m.faceNormal(f);
    const push = (k: number) => {
      const c = a + k, v = m.corners[c];
      s!.pos.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
      if (cornerNormals) s!.nrm.push(cornerNormals[c * 3], cornerNormals[c * 3 + 1], cornerNormals[c * 3 + 2]);
      else if (m.smooth[f]) s!.nrm.push(vn![v * 3], vn![v * 3 + 1], vn![v * 3 + 2]);
      else s!.nrm.push(fn![0], fn![1], fn![2]);
      s!.corners.push(v);
      s!.faces.push(f);
    };
    for (let k = 1; k + 1 < n; k++) { push(0); push(k); push(k + 1); }
  }
  const res = new Map<number, SlotGeo>();
  for (const [slot, s] of out) {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(s.pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(s.nrm), 3));
    res.set(slot, { geo, corners: s.corners, faces: s.faces });
  }
  return res;
}

export interface RenderOptions {
  materials: Map<string, NycMaterial>;
  cornerNormals: (m: Mesh) => Float32Array | undefined;
  snowShellMaterial: Material | null;
}

export function buildNycGroup(ls: Leaf[], opt: RenderOptions): Group {
  const group = new Group();
  group.name = "nycBuilding";
  const snowLayer = new Group();
  snowLayer.name = "snowShell";
  snowLayer.visible = false;

  const byMesh = new Map<Mesh, Leaf[]>();
  for (const l of ls) (byMesh.get(l.mesh) ?? byMesh.set(l.mesh, []).get(l.mesh)!).push(l);

  for (const [mesh, list] of byMesh) {
    const slots = slotGeometries(mesh, opt.cornerNormals(mesh));
    for (const [slot, sg] of slots) {
      const matName = mesh.materials[slot] ?? null;
      const nm = matName ? opt.materials.get(matName) : undefined;
      const material = nm?.material ?? fallback;
      // the mesh's own attributes the material reads (GEOMETRY attributes), packed as vec4
      if (nm) {
        const packs = Array.from({ length: nm.geoPack.packs }, () => new Float32Array(sg.corners.length * 4));
        for (const [name, sl] of nm.geoPack.slots) {
          const src = mesh.point.get(name), fsrc = mesh.face.get(name);
          if (!src && !fsrc) continue;
          const d = packs[sl.pack];
          sg.corners.forEach((v, i) => {
            for (let k = 0; k < sl.size; k++) {
              d[i * 4 + sl.off + k] = src
                ? src.data[v * src.size + (src.size === 3 ? k : 0)]
                : fsrc!.data[sg.faces[i] * fsrc!.size + (fsrc!.size === 3 ? k : 0)];
            }
          });
        }
        packs.forEach((d, i) => sg.geo.setAttribute(`agp${i}`, new BufferAttribute(d, 4)));
      }
      const im = new InstancedMesh(sg.geo, material, list.length);
      im.name = `${mesh.source ?? "gen"}:${matName ?? "-"}`;
      const m4 = new Matrix4();
      list.forEach((l, i) => im.setMatrixAt(i, m4.fromArray(l.matrix)));
      im.instanceMatrix.needsUpdate = true;
      if (nm) {
        // instance attributes (INSTANCER) as packed instanced vec4s
        const packs = Array.from({ length: nm.instPack.packs }, () => new Float32Array(list.length * 4));
        for (const [name, sl] of nm.instPack.slots) {
          const d = packs[sl.pack];
          list.forEach((l, i) => {
            const v = l.attrs.get(name);
            if (v) for (let k = 0; k < sl.size; k++) d[i * 4 + sl.off + k] = v[v.length === sl.size ? k : 0];
          });
        }
        packs.forEach((d, i) => sg.geo.setAttribute(`aip${i}`, new InstancedBufferAttribute(d, 4)));
      }
      const see = nm?.transparent ?? false;
      const glowOnly = !!nm && nm.emissive && material.name.startsWith("NYC_Room");
      im.castShadow = !see && !glowOnly;
      im.receiveShadow = !see;
      if (see) { im.renderOrder = 2; im.userData.noAO = true; }
      im.computeBoundingSphere();
      group.add(im);
      if (opt.snowShellMaterial && !see && !glowOnly) {
        const shell = new InstancedMesh(sg.geo, opt.snowShellMaterial, list.length);
        shell.instanceMatrix = im.instanceMatrix;
        shell.receiveShadow = true;
        shell.boundingSphere = im.boundingSphere;
        snowLayer.add(shell);
      }
    }
  }
  if (snowLayer.children.length) group.add(snowLayer);
  return group;
}

export function disposeNycGroup(g: Group): void {
  g.traverse(o => {
    const m = o as TMesh;
    if ((m as InstancedMesh).isInstancedMesh && o.parent?.name !== "snowShell") m.geometry.dispose();
  });
}
