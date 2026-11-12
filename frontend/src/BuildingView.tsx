// 건물 3D — 층마다 Plan(벽·문·창) + 바닥 + 계단을 세우고, 층을 펼쳐 보고, 층을 골라 들여다보고, 위험을 빨갛게 보여 준다.
//
// 움직임 순서(처음 한 번, 사용자가 준 hero 애니메이션의 타임라인을 일반화):
//   ① 1층 평면 선이 그려짐 → ② 위에서 비스듬히 기울어짐 → ③ 층마다 바닥이 내려앉고 벽이 솟음 → ④ 층이 위아래로 펼쳐짐
// 그 뒤로는 사용자 조작에만 반응한다: 끌어서 돌리기, 층에 올리면 살짝 들림, 층을 누르면 그 층으로 다가감,
// 그 층의 벽·문·창·바닥·계단에 올리면 이름·치수, 위험이면 왜 위험한지.
// 위험 검토(scan)를 켜면 스캔 면이 아래에서 위로 지나가며 걸리는 요소를 빨갛게 표시한다(defect 애니메이션).
//
// 좌표: Plan (x, y) mm → 3D (x/1000, 높이, −y/1000) m. 층 바닥 윗면이 y=0, 바닥판은 그 아래 0.2 m.
// 화면 위 글(층 이름표·설명 상자·검토 상태)은 매 프레임 위치를 바꾸므로 React가 아니라 여기서 직접 만든다.
// design-lint-disable C8: 3D 엔진 — 색은 site-theme.css의 CSS 변수에서 읽고, 코드의 값은 읽지 못했을 때의 기본값과 빛 색이다
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Opening, Wall } from "./api";
import { SLAB_MM, SPACE_LABEL, polygonArea, stairDims, type FloorModel } from "./building";
import { LEVEL_LABEL, type Finding } from "./rules";
import { RISK_PIN } from "./riskPin";
import { makeFadingGrid, stageVar } from "./stageFloor";
import { KIND_LABEL, OPENING_LABEL, wallLength } from "./plan";

export type Layer = "wall" | "door" | "window" | "floor" | "stair" | "space";
export const LAYER_LABEL: Record<Layer, string> = { wall: "벽", door: "문", window: "창", floor: "바닥", stair: "계단", space: "실 이름" };
export const ALL_LAYERS: Layer[] = ["wall", "door", "window", "floor", "stair", "space"];

type Props = {
  floors: FloorModel[];
  className?: string;
  intro?: boolean; // 처음 세우는 움직임
  loop?: boolean; // 펼친 뒤 잠시 보여 주고 되감아 반복 (기본 끔 — DESIGN 8장: 혼자 반복하는 움직임은 사용자가 원할 때만)
  layers?: Record<Layer, boolean>;
  findings?: Finding[];
  scanToken?: number; // 바뀔 때마다 위험 검토 스캔을 한 번 한다
  focus?: number | null; // 들여다보는 층
  onFocus?: (i: number | null) => void;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  compactLabels?: boolean; // 첫 화면: 층 이름표만
  fit?: number; // 카메라 거리 배수 (1 = 기본, 크면 건물이 작게)
  shiftY?: number; // 화면에서 건물을 위로 올리는 비율 (첫 화면 아래 버튼 자리 비우기)
};

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const io = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = (x: number) => 1 - Math.pow(1 - x, 3);
const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Tag = { key: string; kind: Layer; floor: number; name: string; dims: string };

type Api = {
  setLayers: (l: Record<Layer, boolean>) => void;
  setFindings: (f: Finding[]) => void;
  scan: () => void;
  setFocus: (i: number | null) => void;
  setSelected: (k: string | null) => void;
};

export function BuildingView({
  floors, className, intro = true, loop = false, layers, findings = [], scanToken = 0, focus = null, onFocus, selected = null, onSelect, compactLabels = false, fit = 1, shiftY = 0,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const cb = useRef({ onFocus, onSelect });
  cb.current = { onFocus, onSelect };
  const init = useRef({ layers, findings, focus, selected });
  init.current = { layers, findings, focus, selected };

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = "이 브라우저에서는 3D를 그릴 수 없어요.";
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "block size-full";
    el.prepend(renderer.domElement);
    el.classList.add("select-none"); // 끌어서 돌릴 때 위에 뜬 글(이름표·설명)이 선택돼 파랗게 칠해지지 않게

    // ── 색 (site-theme.css의 --color-model-* · --color-risk) ──
    const COL = {
      wall: css("--color-model-wall", "#dddbd6"),
      slab: css("--color-model-slab", "#d2d0ca"),
      edge: css("--color-model-edge", "#4a4945"),
      line: css("--color-model-line", "#2a2926"),
      glass: css("--color-model-glass", "#c9d6dc"),
      door: css("--color-model-door", "#b9a27f"),
      stair: css("--color-model-stair", "#cfccc5"),
      red: css("--color-risk", "#d9363e"),
      sel: css("--color-accent", "#2f4a6b"),
    };
    const RED = new THREE.Color(COL.red);
    const SEL = new THREE.Color(COL.sel);

    // ── 장면 ──
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.3, 600);
    // 원본 애니메이션(three r128)의 빛 세기 × π — 지금 three는 물리 단위라 같은 밝기가 되려면 π배가 필요하다
    scene.add(new THREE.HemisphereLight("#ffffff", "#8f8c85", 0.72 * Math.PI));
    const sun = new THREE.DirectionalLight("#ffffff", 0.45 * Math.PI);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(sun.target);

    // 층 맞추기 — 층마다 따로 올린 도면은 좌표의 시작점이 서로 다르다(그림마다 여백이 다름).
    // 그대로 쌓으면 위층이 옆으로 밀려 나므로, 층마다 벽 범위의 가운데를 1층 가운데에 맞춘다.
    // 샘플처럼 처음부터 같은 좌표로 만든 층(작업 ID 없음)은 건드리지 않는다. ⚠ 가운데 맞춤은 어림이다 — 층 모양이 다르면 어긋날 수 있다.
    const centers = floors.map((f) => {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const w of f.plan.walls) for (const q of [w.start, w.end]) { a = Math.min(a, q.x / 1000); b = Math.max(b, q.x / 1000); c = Math.min(c, -q.y / 1000); d = Math.max(d, -q.y / 1000); }
      return isFinite(a) ? { x: (a + b) / 2, z: (c + d) / 2 } : null;
    });
    const c0 = centers.find((c) => c) ?? { x: 0, z: 0 };
    const shift = floors.map((f, i) => (f.jobId && centers[i] ? { x: c0.x - centers[i]!.x, z: c0.z - centers[i]!.z } : { x: 0, z: 0 }));

    // 건물 전체 범위 → 가운데 맞추기
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    floors.forEach((f, i) => {
      for (const w of f.plan.walls)
        for (const q of [w.start, w.end]) {
          minX = Math.min(minX, q.x / 1000 + shift[i].x); maxX = Math.max(maxX, q.x / 1000 + shift[i].x);
          minZ = Math.min(minZ, -q.y / 1000 + shift[i].z); maxZ = Math.max(maxZ, -q.y / 1000 + shift[i].z);
        }
    });
    if (!isFinite(minX)) { minX = 0; maxX = 10; minZ = 0; maxZ = 10; }
    const span = Math.max(maxX - minX, maxZ - minZ, 4);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    Object.assign(sc, { left: -span * 1.4, right: span * 1.4, top: span * 1.4, bottom: -span * 1.4, near: 1, far: span * 6 });
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(span * 14, span * 14), new THREE.ShadowMaterial({ opacity: 0.13 }));
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -SLAB_MM / 1000;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);
    // 바닥 격자 — 무대 CSS 변수 --stage-grid-style(lines | dots | none)이 정한다 (stageFloor.ts)
    const gridStyle = stageVar(el, "--stage-grid-style", "none");
    if (gridStyle !== "none") {
      scene.add(makeFadingGrid({ center: new THREE.Vector3(0, 0, 0), radius: span * Number(stageVar(el, "--stage-grid-reach", "2.2")), y: -SLAB_MM / 1000 - 0.003,
        color: stageVar(el, "--stage-grid", "#8f8e88"), alpha: Number(stageVar(el, "--stage-grid-alpha", "0.24")), dots: gridStyle === "dots" }));
    }

    const root = new THREE.Group();
    root.position.set(-(minX + maxX) / 2, 0, -(minZ + maxZ) / 2);
    scene.add(root);

    const FH = floors.map((f) => f.heightMm / 1000);
    const base = FH.map((_, i) => FH.slice(0, i).reduce((a, b) => a + b, 0)); // 층 바닥 높이(펼치기 전)
    const GAP = Math.max(3, span * 0.29); // 펼친 간격
    const totalH = base[base.length - 1] + FH[FH.length - 1];

    const tagged: THREE.Mesh[] = []; // 누를 수 있는 메시
    const spaceTags: { key: string; floor: number; text: string; strong: boolean }[] = []; // 실 이름표 (들여다보는 층에서만)
    const groupsByKey = new Map<string, { meshes: THREE.Mesh[]; base: THREE.Color[]; tag: Tag; anchor: THREE.Vector3; floor: number }>();

    type FloorRec = {
      g: THREE.Group; slab: THREE.Mesh; wallGroups: THREE.Group[]; lineGeo: THREE.BufferGeometry; lineMat: THREE.LineBasicMaterial;
      count: number; hover: number; layerGroups: Record<Layer, THREE.Object3D[]>; mats: THREE.Material[]; fade: number; edge: THREE.LineBasicMaterial;
    };
    const recs: FloorRec[] = [];

    const register = (mesh: THREE.Mesh, tag: Tag, rec: FloorRec) => {
      mesh.userData.tag = tag;
      tagged.push(mesh);
      let e = groupsByKey.get(tag.key);
      if (!e) { e = { meshes: [], base: [], tag, anchor: new THREE.Vector3(), floor: tag.floor }; groupsByKey.set(tag.key, e); }
      e.meshes.push(mesh);
      e.base.push((mesh.material as THREE.MeshStandardMaterial).color.clone());
      rec.mats.push(mesh.material as THREE.Material);
    };

    floors.forEach((F, fi) => {
      const g = new THREE.Group();
      g.position.set(shift[fi].x, 0, shift[fi].z);
      root.add(g);
      const rec: FloorRec = {
        g, slab: null as unknown as THREE.Mesh, wallGroups: [], lineGeo: new THREE.BufferGeometry(), lineMat: new THREE.LineBasicMaterial(),
        count: 0, hover: 0, layerGroups: { wall: [], door: [], window: [], floor: [], stair: [], space: [] }, mats: [], fade: 1,
        edge: new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.28 }),
      };
      const edgeM = rec.edge;
      const lines: number[] = [];
      const L = (x0: number, z0: number, x1: number, z1: number) => lines.push(x0, 0.01, z0, x1, 0.01, z1);

      // 바닥판: 벽 범위 + 여유 10cm
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const w of F.plan.walls) for (const q of [w.start, w.end]) {
        a = Math.min(a, q.x / 1000); b = Math.max(b, q.x / 1000); c = Math.min(c, -q.y / 1000); d = Math.max(d, -q.y / 1000);
      }
      if (!isFinite(a)) { a = minX; b = maxX; c = minZ; d = maxZ; }
      const slabGeo = new THREE.BoxGeometry(b - a + 0.4, SLAB_MM / 1000, d - c + 0.4);
      const slab = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: COL.slab, roughness: 1, transparent: true }));
      slab.position.set((a + b) / 2, -SLAB_MM / 2000, (c + d) / 2);
      slab.receiveShadow = true;
      slab.castShadow = true;
      slab.add(new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), edgeM));
      g.add(slab);
      rec.slab = slab;
      rec.layerGroups.floor.push(slab);
      register(slab, { key: `${fi}:floor`, kind: "floor", floor: fi, name: `${F.name} 바닥`, dims: `${(b - a).toFixed(1)} × ${(d - c).toFixed(1)} m · 층고 ${(F.heightMm / 1000).toFixed(2)} m` }, rec);
      groupsByKey.get(`${fi}:floor`)!.anchor.set((a + b) / 2, 0, (c + d) / 2);

      // 공간(실) — 인식 결과에 spaces가 있으면 바닥 위에 얇게 칠하고 이름을 붙인다(AI Hub 공간 12종)
      (F.plan.spaces ?? []).forEach((sp) => {
        if (sp.polygon.length < 3) return;
        const shape = new THREE.Shape(sp.polygon.map((q) => new THREE.Vector2(q.x / 1000, q.y / 1000)));
        const geo = new THREE.ShapeGeometry(shape);
        const strong = sp.type === "stair" || sp.type === "elevator";
        const mat = new THREE.MeshStandardMaterial({ color: strong ? COL.edge : COL.slab, roughness: 1, transparent: true, opacity: strong ? 0.22 : 0.5, depthWrite: false, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2; // (x, y) → (x, 0, −y)
        mesh.position.y = 0.006;
        mesh.renderOrder = 1;
        g.add(mesh);
        rec.layerGroups.space.push(mesh);
        const area = polygonArea(sp.polygon) / 1e6;
        register(mesh, { key: `${fi}:${sp.id}`, kind: "space", floor: fi, name: `${F.name} · ${SPACE_LABEL[sp.type]} ${sp.id}`, dims: `면적 ${area.toFixed(1)} ㎡${sp.confidence != null ? ` · 인식 ${Math.round(sp.confidence * 100)}%` : ""}` }, rec);
        const cx = sp.polygon.reduce((a, q) => a + q.x, 0) / sp.polygon.length / 1000;
        const cz = -sp.polygon.reduce((a, q) => a + q.y, 0) / sp.polygon.length / 1000;
        groupsByKey.get(`${fi}:${sp.id}`)!.anchor.set(cx, 0.05, cz);
        spaceTags.push({ key: `${fi}:${sp.id}`, floor: fi, text: SPACE_LABEL[sp.type], strong });
      });

      // 벽(문·창 구멍 포함) — 벽 하나 = 묶음 하나, 벽 방향으로 돌린다
      const byWall = new Map<string, Opening[]>();
      F.plan.openings.forEach((o) => byWall.set(o.wall_id, [...(byWall.get(o.wall_id) ?? []), o]));
      const total = F.plan.walls.length + F.stairs.length;

      F.plan.walls.forEach((w: Wall, wi) => {
        const len = wallLength(w) / 1000;
        if (len < 0.01) return;
        const th = w.thickness / 1000;
        const wh = w.height / 1000;
        const ux = (w.end.x - w.start.x) / 1000 / len;
        const uz = -(w.end.y - w.start.y) / 1000 / len;
        const nx = -uz, nz = ux;
        const x0 = w.start.x / 1000, z0 = -w.start.y / 1000;
        const wg = new THREE.Group();
        wg.position.set(x0, 0, z0);
        wg.rotation.y = Math.atan2(-uz, ux); // 로컬 x축 = 벽 방향
        wg.userData.order = wi / Math.max(1, total);
        g.add(wg);
        rec.wallGroups.push(wg);
        rec.layerGroups.wall.push(wg);
        const wallMat = new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.95, transparent: true });
        const wallTag: Tag = { key: `${fi}:${w.id}`, kind: "wall", floor: fi, name: `${F.name} · ${KIND_LABEL[w.kind]} ${w.id}`, dims: `길이 ${len.toFixed(2)} m · 두께 ${Math.round(w.thickness)} mm · 높이 ${wh.toFixed(2)} m` };
        const piece = (s0: number, s1: number, y0: number, y1: number, mat: THREE.Material, tag: Tag | null, t = th, parent: THREE.Object3D = wg) => {
          if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return null;
          const geo = new THREE.BoxGeometry(s1 - s0, y1 - y0, t);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set((s0 + s1) / 2, (y0 + y1) / 2, 0);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeM));
          parent.add(mesh);
          if (tag) register(mesh, tag, rec);
          return mesh;
        };
        const ext = th / 2; // 모서리가 비지 않게 양끝을 두께 절반씩 늘린다
        const ops = [...(byWall.get(w.id) ?? [])].sort((p, q) => p.position - q.position);
        let cur = -ext;
        const flat = (s0: number, s1: number, o: number) =>
          L(x0 + ux * s0 + nx * o, z0 + uz * s0 + nz * o, x0 + ux * s1 + nx * o, z0 + uz * s1 + nz * o);
        for (const o of ops) {
          const s0 = o.position / 1000 - o.width / 2000;
          const s1 = o.position / 1000 + o.width / 2000;
          piece(cur, s0, 0, wh, wallMat, wallTag);
          flat(cur, s0, th / 2); flat(cur, s0, -th / 2);
          cur = s1;
          const sill = o.sill_height / 1000;
          const head = Math.min(wh, sill + o.height / 1000);
          piece(s0, s1, 0, sill, wallMat, wallTag);
          piece(s0, s1, head, wh, wallMat, wallTag);
          const og = new THREE.Group();
          wg.add(og);
          const oTag: Tag = {
            key: `${fi}:${o.id}`, kind: o.type, floor: fi, name: `${F.name} · ${OPENING_LABEL[o.type]} ${o.id}`,
            dims: `폭 ${Math.round(o.width)} mm · 높이 ${Math.round(o.height)} mm${o.type === "window" ? ` · 창대 ${Math.round(o.sill_height)} mm` : ""}`,
          };
          if (o.type === "window") {
            const glass = new THREE.MeshStandardMaterial({ color: COL.glass, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.45, depthWrite: false });
            const m = piece(s0, s1, sill, head, glass, oTag, 0.03, og);
            if (m) m.castShadow = false;
            [-th / 2, 0, th / 2].forEach((q) => flat(s0, s1, q));
            rec.layerGroups.window.push(og);
          } else {
            const leaf = new THREE.MeshStandardMaterial({ color: COL.door, roughness: 0.8, transparent: true, opacity: 0.9 });
            piece(s0, s1, sill, head, leaf, oTag, 0.04, og);
            // 평면: 문 열림 호 + 문짝
            const N = 12, sgn = fi % 2 ? -1 : 1, wd = o.width / 1000;
            const hx = x0 + ux * s0, hz = z0 + uz * s0;
            for (let k = 0; k < N; k++) {
              const p = (t: number) => [hx + (ux * Math.cos(t) + nx * sgn * Math.sin(t)) * wd, hz + (uz * Math.cos(t) + nz * sgn * Math.sin(t)) * wd];
              const [ax, az] = p((k / N) * Math.PI / 2), [bx, bz] = p(((k + 1) / N) * Math.PI / 2);
              L(ax, az, bx, bz);
            }
            L(hx, hz, hx + nx * sgn * wd, hz + nz * sgn * wd);
            rec.layerGroups.door.push(og);
          }
          const ctr = new THREE.Vector3(x0 + ux * (o.position / 1000), head, z0 + uz * (o.position / 1000));
          groupsByKey.get(oTag.key)?.anchor.copy(ctr);
        }
        piece(cur, len + ext, 0, wh, wallMat, wallTag);
        flat(cur, len + ext, th / 2); flat(cur, len + ext, -th / 2);
        groupsByKey.get(wallTag.key)?.anchor.set(x0 + ux * len / 2, wh, z0 + uz * len / 2);
      });

      // 계단 — 오르는 방향으로 단을 쌓아 다음 층 바닥까지
      F.stairs.forEach((s, si) => {
        const sg = new THREE.Group();
        sg.userData.order = (F.plan.walls.length + si) / Math.max(1, total);
        g.add(sg);
        rec.wallGroups.push(sg);
        rec.layerGroups.stair.push(sg);
        const mat = new THREE.MeshStandardMaterial({ color: COL.stair, roughness: 0.95, transparent: true });
        const X0 = Math.min(s.x0, s.x1) / 1000, X1 = Math.max(s.x0, s.x1) / 1000;
        const Z0 = -Math.max(s.y0, s.y1) / 1000, Z1 = -Math.min(s.y0, s.y1) / 1000;
        const rise = F.heightMm / 1000 / s.steps;
        const { width, run } = stairDims(s);
        const tag: Tag = {
          key: `${fi}:${s.id}`, kind: "stair", floor: fi, name: `${F.name} · 계단 ${s.id}`,
          dims: `폭 ${(width / 1000).toFixed(2)} m · 길이 ${(run / 1000).toFixed(2)} m · ${s.steps}단 · 단높이 ${Math.round(F.heightMm / s.steps)} mm`,
        };
        for (let k = 0; k < s.steps; k++) {
          // 방향별 k번째 단의 평면 범위
          const f0 = k / s.steps, f1 = (k + 1) / s.steps;
          let bx0 = X0, bx1 = X1, bz0 = Z0, bz1 = Z1;
          if (s.dir === "x+") { bx0 = lerp(X0, X1, f0); bx1 = lerp(X0, X1, f1); }
          if (s.dir === "x-") { bx0 = lerp(X1, X0, f1); bx1 = lerp(X1, X0, f0); }
          if (s.dir === "y+") { bz0 = lerp(Z1, Z0, f1); bz1 = lerp(Z1, Z0, f0); } // y+ = 3D −z
          if (s.dir === "y-") { bz0 = lerp(Z0, Z1, f0); bz1 = lerp(Z0, Z1, f1); }
          const geo = new THREE.BoxGeometry(bx1 - bx0, (k + 1) * rise - 0.001, bz1 - bz0);
          const m = new THREE.Mesh(geo, mat);
          m.position.set((bx0 + bx1) / 2, ((k + 1) * rise) / 2, (bz0 + bz1) / 2);
          m.castShadow = m.receiveShadow = true;
          m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeM));
          sg.add(m);
          register(m, tag, rec);
          if (s.dir[0] === "x") L(bx0, Z0, bx0, Z1); else L(X0, bz0, X1, bz0);
        }
        L(X0, Z0, X1, Z0); L(X1, Z0, X1, Z1); L(X1, Z1, X0, Z1); L(X0, Z1, X0, Z0);
        groupsByKey.get(tag.key)?.anchor.set((X0 + X1) / 2, F.heightMm / 1000, (Z0 + Z1) / 2);
      });

      rec.lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
      rec.lineMat = new THREE.LineBasicMaterial({ color: COL.line, transparent: true, opacity: fi === 0 ? 1 : 0 });
      g.add(new THREE.LineSegments(rec.lineGeo, rec.lineMat));
      rec.count = lines.length / 3;
      recs.push(rec);
    });

    // ── 타임라인 (hero를 층 수에 맞게 늘림) ──
    const T = {
      planA: 0.3, planB: 2.3, tiltA: 1.9, tiltB: 3.8,
      f: floors.map((_, i) => ({ slab: 3.0 + i * 1.6, wallA: 3.3 + i * 1.6, wallB: 4.6 + i * 1.4 })),
      expA: 0, expB: 0, end: 0,
    };
    const lastB = T.f.length ? T.f[T.f.length - 1].wallB : 3;
    T.expA = lastB + 0.6; T.expB = T.expA + 1.6; T.end = T.expB + 0.4;

    // ── 화면 위 글 ──
    const mk = (cls: string, html = "") => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; el.appendChild(d); return d; };
    const floorLabels = floors.map((F, i) => {
      const b = mk("absolute top-0 left-0 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap opacity-0 transition-colors");
      b.innerHTML = `<i class="block h-px w-7 bg-ink/50"></i><button type="button" class="pointer-events-auto rounded-full border border-ink bg-bg px-2.5 py-1 text-label font-semibold text-ink hover:bg-ink hover:text-bg">${esc(F.name)}</button>${F.note && !compactLabels ? `<span class="text-label text-ink-3">${esc(F.note)}</span>` : F.note ? `<span class="hidden text-label text-ink-3 sm:inline">${esc(F.note)}</span>` : ""}`;
      b.querySelector("button")!.addEventListener("click", () => cb.current.onFocus?.(focusIdx === i ? null : i));
      return b;
    });
    const spaceEls = spaceTags.map((t) => mk(`pointer-events-none absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap px-1.5 text-label opacity-0 ${t.strong ? "bg-ink font-semibold text-bg" : "bg-bg/80 text-ink-2"}`, esc(t.text)));
    const tip = mk("pointer-events-none absolute top-0 left-0 z-10 max-w-72 border border-line bg-surface px-3 py-2 text-left opacity-0 shadow-raised");
    // 검토 상태는 오른쪽 위 가장자리 — 가운데 위는 모형 지붕과 겹쳤다
    const chip = mk("pointer-events-none absolute top-3 right-3 flex items-center gap-2 rounded-full bg-ink px-3.5 py-1.5 text-label whitespace-nowrap text-bg opacity-0 transition-opacity");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pointer-events-none absolute inset-0 size-full");
    el.appendChild(svg);

    // ── 상태 ──
    let t = reduce || !intro ? T.end : 0, dir = 1, hold = 0, clock = 0, last = performance.now();
    let introDone = t >= T.end;
    let layerOn: Record<Layer, boolean> = { wall: true, door: true, window: true, floor: true, stair: true, space: true, ...(init.current.layers ?? {}) };
    let found = new Map<string, Finding[]>();
    let scanT = -1; // 0..1 스캔 진행, -1 = 안 함
    let scanDoneAt = -1; // 스캔이 끝난 시각 — 상태 표시는 잠깐 보여 주고 접는다(결과는 옆 목록에)
    let flagged = new Map<string, number>(); // key → 표시 시작 시각(clock)
    let focusIdx: number | null = init.current.focus ?? null;
    let selectedKey: string | null = init.current.selected ?? null;
    let hoverFloor = -1;
    let hoverKey: string | null = null;
    const mouse = new THREE.Vector2(), mpx = { x: 0, y: 0 };
    let pointerIn = false;

    // 사용자 조작용 카메라 (처음 세우기가 끝나면 넘겨받는다)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enabled = false;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = span * 0.5;
    controls.maxDistance = span * 8;
    let camTween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; s: number; d: number } | null = null;

    const explodedY = (i: number, exp: number) => base[i] + exp * i * GAP;

    const camAt = (tt: number, clk: number) => {
      // hero의 카메라: 위에서 → 비스듬히, 펼칠수록 멀리
      const tilt = io(seg(tt, T.tiltA, T.tiltB)), exp = io(seg(tt, T.expA, T.expB));
      const drift = 0.22 * Math.sin(clk * 0.12) * tilt * (introDone ? 0 : 1);
      const pol = lerp(0.02, 0.98, tilt) + 0.14 * exp;
      const az = lerp(0, -0.62, tilt) + drift;
      let r = span * lerp(2.6, 2.75, tilt) + (totalH + GAP * (floors.length - 1)) * 1.25 * exp;
      if (camera.aspect < 1.25) r *= 1.25 / Math.max(camera.aspect, 0.55);
      r *= fit;
      const ty = lerp(0, totalH * 0.45, io(seg(tt, T.f[0]?.wallA ?? 3, lastB))) + exp * GAP * (floors.length - 1) * 0.5;
      const tgt = new THREE.Vector3(0, ty, 0);
      const pos = new THREE.Vector3(r * Math.sin(pol) * Math.sin(az), ty + r * Math.cos(pol), r * Math.sin(pol) * Math.cos(az));
      return { pos, tgt };
    };

    const goCamera = (pos: THREE.Vector3, tgt: THREE.Vector3) => {
      if (reduce) { camera.position.copy(pos); controls.target.copy(tgt); return; }
      camTween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt, s: clock, d: 0.8 };
    };

    const focusView = (i: number) => {
      const y = explodedY(i, 1);
      const tgt = new THREE.Vector3(0, y + 0.8, 0);
      const dirv = camera.position.clone().sub(controls.target).normalize();
      dirv.y = Math.max(dirv.y, 0.75); dirv.normalize();
      return { pos: tgt.clone().addScaledVector(dirv, (span * 2.3) / Math.min(1, Math.max(0.6, camera.aspect / 1.4))), tgt };
    };

    // ── 크기 ──
    let Wd = 1, Hd = 1;
    let offX = 0; // 설명 단 자리를 비우려고 모형을 오른쪽으로 민 만큼(px)
    let zoomK = 1; // 설명 단이 들어가게 모형을 줄인 정도(1 = 그대로)
    let boxesOn = false;
    const applyOffset = () => {
      if (shiftY || offX > 0.5) camera.setViewOffset(Wd, Hd, -offX, Hd * shiftY, Wd, Hd); else camera.clearViewOffset();
      camera.zoom = zoomK;
      camera.updateProjectionMatrix();
    };
    const resize = () => {
      Wd = el.clientWidth; Hd = el.clientHeight; renderer.setSize(Wd, Hd, false); camera.aspect = Wd / Math.max(1, Hd);
      applyOffset();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // ── 고르기 ──
    const ray = new THREE.Raycaster();
    const visiblePick = () => tagged.filter((m) => {
      let o: THREE.Object3D | null = m;
      while (o) { if (!o.visible) return false; o = o.parent; }
      const tg = m.userData.tag as Tag;
      return focusIdx === null || tg.floor === focusIdx;
    });
    const pickTag = (): Tag | null => {
      ray.setFromCamera(mouse, camera);
      const h = ray.intersectObjects(visiblePick(), false);
      // 같은 자리면 창·문을 벽보다 먼저
      const first = h.find((x) => ["window", "door"].includes((x.object.userData.tag as Tag).kind) && x.distance - h[0].distance < 0.3) ?? h[0];
      return first ? (first.object.userData.tag as Tag) : null;
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mpx.x = e.clientX - r.left; mpx.y = e.clientY - r.top;
      mouse.set((mpx.x / r.width) * 2 - 1, -(mpx.y / r.height) * 2 + 1);
      pointerIn = true;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || !introDone) { down = null; return; }
      down = null;
      const tg = pickTag();
      if (focusIdx === null) {
        if (tg) cb.current.onFocus?.(tg.floor);
      } else {
        cb.current.onSelect?.(tg ? tg.key : null);
      }
    };
    const onLeave = () => { pointerIn = false; };
    const cv = renderer.domElement;
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointerleave", onLeave);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && focusIdx !== null) cb.current.onFocus?.(null); };
    window.addEventListener("keydown", onKey);

    // ── 칠하기 ──
    const paint = () => {
      for (const [key, e] of groupsByKey) {
        const k = flagged.has(key) ? clamp((clock - flagged.get(key)!) / 0.45) : 0;
        const pulse = 0.5 + 0.5 * Math.sin(clock * 4.2);
        e.meshes.forEach((m, i) => {
          const mat = m.material as THREE.MeshStandardMaterial;
          const c = e.base[i].clone();
          if (k > 0) c.lerp(RED, 0.85 * k);
          if (key === selectedKey) c.lerp(SEL, 0.55);
          else if (key === hoverKey && introDone) c.offsetHSL(0, 0, -0.06);
          mat.color.copy(c);
          if (mat.emissive) { mat.emissive.copy(RED); mat.emissiveIntensity = k * (0.1 + 0.15 * pulse); }
        });
      }
    };

    // ── 스캔 면 ──
    const scanG = new THREE.Group();
    scene.add(scanG);
    const scanFill = new THREE.MeshBasicMaterial({ color: "#1c1c1a", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 2.4, maxZ - minZ + 2.4), scanFill);
    sp.rotation.x = -Math.PI / 2;
    scanG.add(sp);
    const scanLine = new THREE.LineBasicMaterial({ color: "#1c1c1a", transparent: true, opacity: 0 });
    const hw = (maxX - minX) / 2 + 1.2, hd = (maxZ - minZ) / 2 + 1.2;
    scanG.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, z]) => new THREE.Vector3(x * hw, 0, z * hd))), scanLine));

    // ── 화면 좌표 ──
    const v3 = new THREE.Vector3();
    const toScreen = (v: THREE.Vector3) => { v3.copy(v).project(camera); return [(v3.x * 0.5 + 0.5) * Wd, (-v3.y * 0.5 + 0.5) * Hd]; };
    const worldAnchor = (key: string) => {
      const e = groupsByKey.get(key)!;
      const w = e.anchor.clone();
      recs[e.floor].g.localToWorld(w);
      return w;
    };

    // 위험 번호 — 스캔으로 찾은 요소마다 번호 하나(옆 위험 목록의 번호와 같다). 설명 글은 목록과 커서 설명에.
    //   왜: 3D 위에 글 상자 여러 개를 띄우면 좁은 무대(12칸 중 8칸)에서 상자끼리·모형·층 이름표를 덮어 읽기 힘들었다(2026-10-30).
    //   설명 상자는 무대 왼쪽 단에 세로로 늘어놓고 가는 선으로 번호와 잇는다. 모형이 그 단을 침범하면 화면을 옆으로 밀어(view offset)
    //   돌려도 상자가 모형을 덮지 않는다 — "위험건수가 도면을 가리잖아, 돌려도 가리지 않고 옆으로 퍼지게"(2026-10-30). 좁은 무대(560px 미만)는 번호만.
    let pins: { key: string; floor: number; pin: HTMLButtonElement; line: SVGPolylineElement; dot: SVGCircleElement; ring: SVGCircleElement; box: HTMLDivElement; lead: SVGPolylineElement }[] = [];
    const buildPins = () => {
      pins.forEach((c) => { c.pin.remove(); c.line.remove(); c.dot.remove(); c.ring.remove(); c.box.remove(); c.lead.remove(); });
      pins = [];
      [...found.entries()].forEach(([key, fs], i) => {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = `${RISK_PIN} pointer-events-auto absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 opacity-0 shadow-raised hover:ring-2 hover:ring-ink`;
        pin.style.visibility = "hidden";
        pin.textContent = String(i + 1);
        const label = `위험 ${i + 1}: ${floors[fs[0].floor]?.name ?? ""} ${fs.map((f) => f.title).join(", ")}`;
        pin.setAttribute("aria-label", label);
        pin.title = label;
        pin.addEventListener("click", () => { cb.current.onFocus?.(fs[0].floor); cb.current.onSelect?.(key); });
        el.appendChild(pin);
        const NS = "http://www.w3.org/2000/svg";
        const line = document.createElementNS(NS, "polyline");
        line.setAttribute("fill", "none"); line.setAttribute("stroke", COL.red); line.setAttribute("stroke-width", "1");
        const dot = document.createElementNS(NS, "circle"); dot.setAttribute("r", "3"); dot.setAttribute("fill", COL.red);
        const ring = document.createElementNS(NS, "circle"); ring.setAttribute("fill", "none"); ring.setAttribute("stroke", COL.red);
        const lead = document.createElementNS(NS, "polyline");
        lead.setAttribute("fill", "none"); lead.setAttribute("stroke", COL.red); lead.setAttribute("stroke-width", "1");
        svg.append(line, lead, ring, dot);
        const f0 = fs[0];
        const box = mk("pointer-events-auto absolute top-0 left-3 w-52 -translate-y-1/2 cursor-pointer border border-line border-l-2 border-l-(--color-risk) bg-surface/95 px-2.5 py-1.5 opacity-0 shadow-raised backdrop-blur-sm",
          `<span class="flex items-baseline gap-1.5"><b class="text-label font-semibold tabular-nums text-danger">${i + 1}</b><b class="truncate text-body-sm font-semibold text-ink">${esc(f0.title)}</b>${fs.length > 1 ? `<span class="shrink-0 text-label text-ink-3">외 ${fs.length - 1}</span>` : ""}</span><span class="block truncate text-label tabular-nums text-ink-3">${esc(floors[f0.floor]?.name ?? "")} · <span class="text-danger">${esc(f0.measured)}</span> → ${esc(f0.standard)}</span>`);
        box.setAttribute("aria-hidden", "true"); // 키보드·화면낭독기는 번호 버튼과 옆 목록으로
        box.style.visibility = "hidden";
        box.addEventListener("click", () => { cb.current.onFocus?.(f0.floor); cb.current.onSelect?.(key); });
        pins.push({ key, floor: f0.floor, pin, line, dot, ring, box, lead });
      });
    };

    api.current = {
      setLayers: (l) => {
        layerOn = l;
        recs.forEach((r) => (Object.keys(r.layerGroups) as Layer[]).forEach((k) => r.layerGroups[k].forEach((o) => (o.visible = l[k]))));
      },
      setFindings: (f) => {
        found = new Map();
        f.forEach((x) => found.set(x.key, [...(found.get(x.key) ?? []), x]));
        flagged = new Map([...flagged].filter(([k]) => found.has(k)));
        buildPins();
      },
      scan: () => {
        flagged = new Map();
        if (reduce) { found.forEach((_, k) => flagged.set(k, clock - 1)); scanT = 1; scanDoneAt = clock; return; }
        scanT = 0;
        scanDoneAt = -1;
        if (focusIdx !== null) cb.current.onFocus?.(null);
      },
      setFocus: (i) => {
        focusIdx = i;
        if (!introDone) return;
        if (i === null) { const h = camAt(T.end, clock); goCamera(h.pos, h.tgt); }
        else { const v = focusView(i); goCamera(v.pos, v.tgt); }
      },
      setSelected: (k) => { selectedKey = k; },
    };
    api.current.setLayers(layerOn);
    api.current.setFindings(init.current.findings ?? []);

    // ── 매 프레임 ──
    const tmp = new THREE.Vector3();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;

      // 처음 세우기 (반복은 loop일 때만)
      if (!introDone || loop) {
        if (dir > 0) { t += dt; if (t >= T.end) { t = T.end; hold += dt; if (!introDone) { introDone = true; handOff(); } if (loop && hold > 4.5 && focusIdx === null && !pointerIn) { dir = -1; hold = 0; controls.enabled = false; } } }
        else { t -= dt * 3; if (t <= 0) { t = 0; hold += dt; if (hold > 0.6) { dir = 1; hold = 0; introDone = false; } } }
      }
      const exp = io(seg(t, T.expA, T.expB));

      // 층마다: 평면 선, 바닥 내려앉기, 벽 솟기, 펼치기, 들림, 흐리기
      recs.forEach((R, i) => {
        const ft = T.f[i];
        let lineOp = 1;
        if (i === 0) R.lineGeo.setDrawRange(0, Math.floor((seg(t, T.planA, T.planB) * R.count) / 2) * 2);
        else { R.lineGeo.setDrawRange(0, R.count); lineOp = seg(t, ft.slab, ft.slab + 0.5); }
        const s = out(seg(t, ft.slab - (i ? 0 : 0.6), ft.slab + (i ? 0.5 : 0)));
        R.g.visible = i === 0 ? t > 0 : s > 0;
        R.slab.visible = s > 0 && layerOn.floor;
        R.wallGroups.forEach((wg) => {
          const a = lerp(ft.wallA, ft.wallB - 0.6, wg.userData.order);
          const p = out(seg(t, a, a + 0.6));
          wg.scale.y = Math.max(p, 0.001);
        });
        const target = hoverFloor === i && exp > 0.95 && focusIdx === null ? 0.45 : 0;
        R.hover += (target - R.hover) * 0.12;
        R.g.position.y = explodedY(i, exp) + (i === 0 ? 0 : (1 - s) * 1.6) + R.hover;
        // 들여다보는 층 말고는 흐리게
        // 위층은 거의 지우고(시야를 가림), 아래층은 흐리게
        const want = focusIdx === null || focusIdx === i ? 1 : i > focusIdx ? 0 : 0.12;
        R.fade += (want - R.fade) * 0.12;
        R.mats.forEach((m) => { const mm = m as THREE.MeshStandardMaterial; if (mm.opacity !== undefined) mm.opacity = (mm.userData.baseOpacity ??= mm.opacity) * R.fade; mm.depthWrite = R.fade > 0.6 && (mm.userData.baseOpacity ?? 1) > 0.5; });
        R.lineMat.opacity = lineOp * R.fade;
        if (R.fade < 0.02) R.g.visible = false; // 다 사라진 위층은 그림자도 안 생기게
        R.edge.opacity = 0.28 * R.fade;
      });

      // 카메라: 세우는 동안은 대본대로, 끝나면 사용자에게
      if (!introDone || (loop && dir < 0)) {
        const c = camAt(t, clock);
        camera.position.copy(c.pos);
        camera.lookAt(c.tgt);
        controls.target.copy(c.tgt);
      } else {
        if (camTween) {
          const k = io(clamp((clock - camTween.s) / camTween.d));
          camera.position.lerpVectors(camTween.p0, camTween.p1, k);
          controls.target.lerpVectors(camTween.t0, camTween.t1, k);
          if (k >= 1) camTween = null;
        }
        controls.update();
      }
      sun.position.set(controls.target.x - span * 0.9, controls.target.y + span * 1.6, controls.target.z + span * 1.1);
      sun.target.position.copy(controls.target);

      // 스캔
      if (scanT >= 0 && scanT < 1) {
        scanT = Math.min(1, scanT + dt / 2.6);
        if (scanT >= 1) scanDoneAt = clock;
        const y0 = -0.4, y1 = explodedY(floors.length - 1, 1) + FH[FH.length - 1] + 0.6;
        const y = lerp(y0, y1, io(scanT));
        scanG.position.y = y;
        const sv = Math.sin(Math.PI * clamp(scanT * 1.06));
        scanFill.opacity = 0.05 * sv; scanLine.opacity = 0.7 * sv;
        for (const key of found.keys()) if (!flagged.has(key)) {
          const a = worldAnchor(key);
          if (a.y - (groupsByKey.get(key)!.anchor.y * 0.45) <= y) flagged.set(key, clock);
        }
      } else { scanFill.opacity = 0; scanLine.opacity = 0; }

      // 올려 둔 것
      hoverFloor = -1; hoverKey = null;
      if (pointerIn && introDone) {
        const tg = pickTag();
        if (tg) { hoverFloor = tg.floor; if (focusIdx !== null || found.has(tg.key)) hoverKey = tg.key; }
      }
      cv.style.cursor = !introDone ? "default" : hoverKey || (hoverFloor >= 0 && focusIdx === null) ? "pointer" : "grab";
      paint();

      // 실 이름: 들여다보는 층에서만 (전체 보기에선 글이 너무 많다)
      spaceTags.forEach((t, k) => {
        const el2 = spaceEls[k];
        const show = focusIdx === t.floor && layerOn.space && introDone && !camTween;
        el2.style.opacity = show ? "1" : "0";
        if (!show) return;
        const [x, y] = toScreen(worldAnchor(t.key));
        el2.style.left = `${x}px`;
        el2.style.top = `${y}px`;
      });

      // 층 이름표: 건물 오른쪽 끝에
      const lo = seg(t, T.expB - 0.5, T.expB + 0.3);
      recs.forEach((R, i) => {
        let mx = -1e9, sy = 0;
        const y = R.g.position.y + (FH[i] - SLAB_MM / 1000) * 0.5;
        for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]]) {
          tmp.set(x + root.position.x, y, z + root.position.z);
          const [sx, syy] = toScreen(tmp);
          if (sx > mx) { mx = sx; sy = syy; }
        }
        const bad = [...flagged.keys()].some((k) => groupsByKey.get(k)?.floor === i);
        const lb = floorLabels[i];
        lb.style.opacity = String(lo * (focusIdx === null || focusIdx === i ? 1 : 0.35) * (hoverFloor < 0 || hoverFloor === i || focusIdx !== null ? 1 : 0.45));
        lb.style.left = `${Math.max(0, Math.min(mx + 14, Wd - lb.offsetWidth - 8))}px`; // 무대 오른쪽 끝에서 이름표가 잘리지 않게
        lb.style.top = `${sy}px`;
        const btn = lb.querySelector("button")!;
        btn.classList.toggle("border-(--color-risk)", bad);
        btn.classList.toggle("text-danger", bad);
        btn.setAttribute("aria-pressed", String(focusIdx === i));
      });

      // 위험 번호 — 요소 자리에 놓고, 다른 번호와 겹치면 오른쪽 아래로 비켜 두고 가는 선으로 잇는다
      const placed: [number, number][] = [];
      pins.forEach((c) => {
        const k = flagged.has(c.key) ? clamp((clock - flagged.get(c.key)!) / 0.45) : 0;
        const show = k * (focusIdx === null || focusIdx === c.floor ? 1 : 0);
        const [ax, ay] = toScreen(worldAnchor(c.key));
        let px = ax, py = ay;
        for (let n = 0; n < 6 && placed.some(([x, y]) => Math.hypot(x - px, y - py) < 28); n++) { px += 20; py += 20; }
        const on = show > 0.02;
        if (on) placed.push([px, py]);
        const sel = selectedKey === c.key;
        c.pin.style.visibility = on ? "visible" : "hidden"; // 안 보이는 번호는 누르거나 Tab으로 갈 수 없게
        c.pin.style.opacity = String(seg(show, 0.2, 1));
        c.pin.style.left = `${px}px`;
        c.pin.style.top = `${py}px`;
        c.pin.style.zIndex = sel ? "2" : "1";
        c.pin.classList.toggle("ring-2", sel);
        c.pin.classList.toggle("ring-ink", sel);
        c.pin.setAttribute("aria-pressed", String(sel));
        const moved = px !== ax || py !== ay;
        c.line.setAttribute("points", `${ax},${ay} ${px},${py}`);
        c.line.style.opacity = String(moved ? show * 0.8 : 0);
        c.dot.setAttribute("cx", String(ax)); c.dot.setAttribute("cy", String(ay)); c.dot.style.opacity = String(moved ? show : 0);
        const rp = (clock * 1.2) % 1;
        c.ring.setAttribute("cx", String(ax)); c.ring.setAttribute("cy", String(ay)); c.ring.setAttribute("r", String(10 + rp * 12));
        c.ring.style.opacity = String(show * (1 - rp) * 0.6);
      });

      // 설명 상자 — 왼쪽 단(번호 순서가 아니라 번호의 화면 높이 순)에 겹치지 않게 늘어놓는다
      const COL_R = 12 + 208, TOP = 60, BOT = Hd - 76, GAP = 54;
      const shown = pins.filter((c) => c.pin.style.visibility === "visible");
      // 지금 보이는 층들의 화면 범위
      let bx0 = 1e9, bx1 = -1e9;
      recs.forEach((R, i) => {
        if (focusIdx !== null && i > focusIdx) return;
        for (const yy of [R.g.position.y - SLAB_MM / 1000, R.g.position.y + FH[i]])
          for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]]) {
            tmp.set(x + root.position.x, yy, z + root.position.z);
            const [sx] = toScreen(tmp);
            bx0 = Math.min(bx0, sx); bx1 = Math.max(bx1, sx);
          }
      });
      const LABEL_W = 150; // 오른쪽 층 이름표 자리
      const room = Wd - (COL_R + 24) - LABEL_W - 8;
      // 자리가 모자라면 모형을 줄이고(최대 55%까지), 왼쪽 단을 비우도록 오른쪽으로 민다 — 돌릴 때마다 다시 맞춘다
      boxesOn = shown.length > 0 && Wd >= 560;
      const wantZoom = boxesOn ? Math.min(1, Math.max(0.55, ((room * 0.96) / Math.max(1, bx1 - bx0)) * zoomK)) : 1;
      const wantOff = boxesOn ? Math.max(0, offX + (COL_R + 24 - bx0)) : 0;
      const k = Math.min(1, dt * 6);
      if (Math.abs(wantZoom - zoomK) > 0.002 || Math.abs(wantOff - offX) > 0.5) {
        zoomK += (wantZoom - zoomK) * k;
        offX += (wantOff - offX) * k;
        applyOffset();
      }
      const lay = shown.map((c) => ({ c, py: parseFloat(c.pin.style.top), px: parseFloat(c.pin.style.left), y: 0 })).sort((a, b) => a.py - b.py);
      lay.forEach((it, i) => { it.y = Math.max(TOP, it.py, i ? lay[i - 1].y + GAP : TOP); });
      for (let i = lay.length - 1; i >= 0; i--) lay[i].y = Math.min(lay[i].y, (i < lay.length - 1 ? lay[i + 1].y - GAP : BOT));
      pins.forEach((c) => {
        const it = lay.find((l) => l.c === c);
        const on = boxesOn && !!it;
        c.box.style.visibility = on ? "visible" : "hidden";
        c.box.style.opacity = on ? c.pin.style.opacity : "0";
        c.lead.style.opacity = on ? String(parseFloat(c.pin.style.opacity) * 0.8) : "0";
        if (!on || !it) return;
        c.box.style.top = `${it.y}px`;
        c.box.classList.toggle("ring-2", selectedKey === c.key);
        c.box.classList.toggle("ring-ink", selectedKey === c.key);
        c.lead.setAttribute("points", `${COL_R},${it.y} ${COL_R + 12},${it.y} ${it.px - 12},${it.py}`);
      });

      // 검토 상태
      const nFound = [...flagged.keys()].reduce((n, k) => n + (found.get(k)?.length ?? 0), 0);
      const nAll = [...found.values()].reduce((n, a) => n + a.length, 0);
      if (scanT >= 0) {
        const done = scanT >= 1;
        // 끝나고 2.5초 뒤 접는다 — 계속 떠 있으면 층을 고를 때 위층 이름표와 겹쳤다. 결과 수는 옆 목록 머리에 남는다
        chip.style.opacity = String(done && scanDoneAt >= 0 ? clamp(1 - (clock - scanDoneAt - 2.5) / 0.5) : 1);
        chip.innerHTML = `<i class="block size-2 rounded-full ${nFound ? "bg-(--color-risk)" : "bg-ink-3"}"></i><span>${done ? `검토 완료 · 위험 ${nAll}건` : nFound ? `검토 중… 위험 ${nFound}건` : "검토 중…"}</span>`;
      } else chip.style.opacity = "0";

      // 올려 둔 요소 설명 (위험이면 왜)
      const hk = hoverKey;
      if (hk && introDone) {
        const e = groupsByKey.get(hk)!;
        const fs = flagged.has(hk) ? found.get(hk) ?? [] : [];
        tip.innerHTML = `<b class="block text-body-sm font-semibold text-ink">${esc(e.tag.name)}</b><span class="block text-label text-ink-3">${esc(e.tag.dims)}</span>${fs
          .map((f) => `<span class="mt-2 block border-t border-line pt-2"><b class="block text-body-sm font-semibold text-danger">${esc(f.title)} <span class="font-normal text-ink-3">· ${LEVEL_LABEL[f.level]}</span></b><span class="block text-label text-ink">${esc(f.measured)} → 기준 ${esc(f.standard)}</span><span class="mt-1 block text-label whitespace-normal text-ink-2">${esc(f.why)}</span><span class="mt-1 block text-caption whitespace-normal text-ink-3">근거: ${esc(f.basis)}</span></span>`)
          .join("")}`;
        tip.style.opacity = "1";
        const w = tip.offsetWidth, h = tip.offsetHeight;
        tip.style.left = `${Math.min(mpx.x + 16, Wd - w - 8)}px`;
        tip.style.top = `${Math.min(mpx.y + 16, Hd - h - 8)}px`;
      } else tip.style.opacity = "0";

      renderer.render(scene, camera);
    };

    // 세우기가 끝나면 카메라를 사용자에게 넘긴다
    const handOff = () => {
      const c = camAt(T.end, clock);
      camera.position.copy(c.pos);
      controls.target.copy(c.tgt);
      controls.enabled = true;
      if (focusIdx !== null) api.current?.setFocus(focusIdx);
    };
    if (introDone) handOff();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      el.replaceChildren();
      api.current = null;
    };
    // 층 구성이 바뀌면 다시 짓는다. 나머지 값은 아래에서 api로 전달
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floors, intro, loop, compactLabels]);

  useEffect(() => { if (layers) api.current?.setLayers(layers); }, [layers]);
  useEffect(() => { api.current?.setFindings(findings); }, [findings]);
  useEffect(() => { if (scanToken) api.current?.scan(); }, [scanToken]);
  useEffect(() => { api.current?.setFocus(focus); }, [focus]);
  useEffect(() => { api.current?.setSelected(selected); }, [selected]);

  // role="group": 안에 층 이름 버튼(누를 수 있는 것)이 있다 — role="img"면 그 버튼이 화면낭독기에서 사라진다(axe nested-interactive)
  return <div ref={host} className={className ?? "relative size-full"} role="group" aria-label="건물 3D — 층을 눌러 들여다보고, 벽·문·창·바닥·계단에 올리면 설명이 나와요" />;
}
