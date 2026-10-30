// design-lint-disable C8: 3D 엔진 — 색은 site-theme.css의 CSS 변수(--stage-*·--color-*)에서 읽고, 코드의 값은 읽지 못했을 때의 기본값이다
// 3D 뷰어 — 서버가 만든 .glb를 보여주고, 벽·문·창을 눌러 고를 수 있게 한다.
//
// glb 규약(autobim-be docs/api.md "출력 파일"): 벽마다 노드 하나, 노드 이름 = 벽 ID(w1…), m 단위, Y가 위.
//   → 눌린 메시의 이름으로 어떤 벽인지 안다.
// 문·창은 glb 안에서 벽에 뚫린 구멍일 뿐이라, Plan 값으로 얇은 상자 테두리를 그려 보여주고 누를 수 있게 한다.
//   Plan (x, y) mm → 3D (x/1000, 높이, −y/1000)
// 색은 디자인 값(CSS 변수)에서 읽는다 — 2D 평면과 같은 색 약속.
//
// 처음 보일 때 "도면이 건물로 올라가는" 시연을 한 번 한다(작업마다 1회, 약 3초):
//   위에서 본 평면(벽이 납작한 선) → 카메라가 비스듬히 기울고 → 외벽부터 벽이 솟고 → 문·창이 나타난다.
//   누르면 바로 끝, 움직임 줄이기면 생략, "세우기 다시 보기"로 다시. (사용자 요청 2026-10-30, DESIGN 8장)
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Button, Segmented, StageBar } from "@design";
import type { Plan } from "./api";
import { openingCenter, wallDir } from "./plan";
import { makeFadingGrid, makeShadowFloor, stageVar } from "./stageFloor";

type View = "iso" | "top" | "front";
type Props = {
  url: string;
  modelKey: string; // 작업 ID — 시점 기억·세우기 시연을 작업마다 따로 한다
  plan: Plan; // glb와 같은 리비전의 Plan (문·창 위치에 씀)
  selected: string | null;
  review: Set<string>;
  onSelect: (id: string | null) => void;
  onError?: (msg: string) => void;
  overlay?: string | null; // "다시 만드는 중…" 같은 안내
};

const css = (name: string) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "gray");

type Api = { setView: (v: View) => void; setCut: (h: number) => void; paint: (sel: string | null, review: Set<string>) => void; replay: () => void };

// 리비전이 바뀌어 모델을 다시 불러와도 보던 시점을 유지한다 — 같은 작업일 때만.
//   왜: 모든 작업이 시점 하나를 같이 써서, 새 도면을 올리면 앞 작업에서 가까이 본 시점이 그대로 와 벽 한 조각만 보였다(2026-10-30).
let lastCamera: { key: string; pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
// 세우기 시연을 이미 보여 준 작업 (탭을 바꿔 다시 그려도 반복하지 않는다)
const played = new Set<string>();

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);
// 시연 시간표(초)
const RISE = { camA: 0.5, camB: 1.9, wallA: 0.8, wallDur: 0.9, wallSpan: 1.0, openA: 2.4, openDur: 0.5, end: 3.0 };

export function Viewer3D({ url, modelKey, plan, selected, review, onSelect, onError, overlay }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [view, setView] = useState<View>("iso");
  const maxH = Math.max(...plan.walls.map((w) => w.height), 2400) / 1000;
  const [cut, setCut] = useState(maxH);
  const [ready, setReady] = useState(false);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 3D 안의 이벤트는 한 번만 연결하므로, 늘 최신 값을 보도록 ref에 담는다
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selected);
  const reviewRef = useRef(review);
  selectRef.current = onSelect;
  selectedRef.current = selected;
  reviewRef.current = review;

  useEffect(() => {
    const el = host.current!;
    setReady(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // 투명 — 무대 바탕(.stage-backdrop)이 비친다
    } catch {
      onError?.("이 브라우저에서는 3D를 그릴 수 없어요. 평면 보기를 써 주세요.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(-6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 4;
    scene.add(sun);
    scene.add(sun.target);

    const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), maxH + 0.01);
    const colors = {
      wall: css("--color-model-wall"),
      edge: css("--color-model-edge"),
      sel: css("--color-accent"),
      review: css("--color-review"),
      door: css("--color-door"),
      window: css("--color-window"),
    };

    // id → 그 요소를 그리는 재질들 (고르면 색만 바꾼다 — 다시 만들지 않음)
    const wallMats = new Map<string, THREE.MeshStandardMaterial>();
    const openingMats = new Map<string, { line: THREE.LineBasicMaterial; fill: THREE.MeshBasicMaterial; base: THREE.Color }>();
    const pickables: THREE.Object3D[] = [];
    const wallMeshes: THREE.Mesh[] = [];
    let openK = 1; // 문·창 보이기 정도(세우기 시연 중 0→1)
    let size = new THREE.Vector3(10, 3, 10);
    let center = new THREE.Vector3();

    const fit = (v: View) => {
      const r = Math.max(size.x, size.z) * 0.5;
      const dist = (r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.3;
      controls.target.copy(center);
      if (v === "top") camera.position.set(center.x, center.y + dist * 1.1, center.z + 0.001);
      else if (v === "front") camera.position.set(center.x, center.y + size.y * 0.6, center.z + dist);
      else camera.position.set(center.x + dist * 0.65, center.y + dist * 0.8, center.z + dist * 0.75);
      camera.near = dist / 200;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.update();
    };

    // 문·창: Plan 값으로 상자를 만들어 벽 구멍 자리에 놓는다.
    //   glb가 다 오기 전에는 숨긴다 — 카메라를 맞추기 전이라 문 상자 하나가 화면 가득 크게 보였다(2026-10-30 사용자 화면)
    const openingsG = new THREE.Group();
    openingsG.visible = false;
    scene.add(openingsG);
    const walls = new Map(plan.walls.map((w) => [w.id, w]));
    for (const o of plan.openings) {
      const w = walls.get(o.wall_id);
      if (!w) continue;
      const c = openingCenter(o, w);
      const d = wallDir(w);
      const geo = new THREE.BoxGeometry(o.width / 1000, o.height / 1000, (w.thickness * 1.15) / 1000);
      const base = o.type === "door" ? colors.door : colors.window;
      const line = new THREE.LineBasicMaterial({ color: base, transparent: true, clippingPlanes: [clip] });
      const fill = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: 0.18, clippingPlanes: [clip], depthWrite: false });
      const box = new THREE.Mesh(geo, fill);
      box.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), line));
      box.position.set(c.x / 1000, (o.sill_height + o.height / 2) / 1000, -c.y / 1000);
      box.rotation.y = Math.atan2(d.y, d.x);
      box.name = o.id;
      openingsG.add(box);
      pickables.push(box);
      openingMats.set(o.id, { line, fill, base });
    }

    new GLTFLoader().load(
      url,
      (gltf) => {
        gltf.scene.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          // glb에 재질이 없어도 우리 색으로 — 벽마다 재질을 따로 둬야 하나만 색을 바꿀 수 있다
          const id = m.name || m.parent?.name || "";
          // glb에 법선(빛 계산용 면 방향)이 없으면 벽이 까맣게 보인다 → 직접 계산
          if (!m.geometry.getAttribute("normal")) m.geometry.computeVertexNormals();
          const mat = new THREE.MeshStandardMaterial({ color: colors.wall.clone(), roughness: 0.9, side: THREE.DoubleSide, clippingPlanes: [clip], clipShadows: true });
          m.castShadow = true;
          m.receiveShadow = true;
          m.material = mat;
          m.name = id;
          m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: colors.edge, transparent: true, opacity: 0.5, clippingPlanes: [clip] })));
          wallMats.set(id, mat);
          pickables.push(m);
          wallMeshes.push(m);
        });
        scene.add(gltf.scene);
        openingsG.visible = true;
        const box = new THREE.Box3().setFromObject(gltf.scene);
        size = box.getSize(new THREE.Vector3());
        center = box.getCenter(new THREE.Vector3());
        // 무대 바닥: 멀어질수록 흐려지는 격자 + 부드러운 그림자 (stageFloor.ts) — 색·세기는 무대 CSS 변수
        const reach = Math.max(size.x, size.z);
        scene.add(makeFadingGrid({ center, radius: reach * 1.3 + 4, y: box.min.y - 0.002, color: stageVar(el, "--stage-grid", "#9a9993"), alpha: Number(stageVar(el, "--stage-grid-alpha", "0.35")), dots: stageVar(el, "--stage-grid-style", "lines") === "dots" }));
        scene.add(makeShadowFloor({ center, size: reach * 6 + 10, y: box.min.y - 0.001, opacity: Number(stageVar(el, "--stage-shadow", "0.16")) }));
        sun.position.set(center.x - reach * 0.6, center.y + reach * 1.4, center.z + reach * 0.9);
        sun.target.position.copy(center);
        const sc = sun.shadow.camera as THREE.OrthographicCamera;
        Object.assign(sc, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.1, far: reach * 5 });
        sc.updateProjectionMatrix();
        if (lastCamera && lastCamera.key === modelKey) {
          camera.position.copy(lastCamera.pos);
          controls.target.copy(lastCamera.target);
          camera.near = 0.05;
          camera.far = 500;
          camera.updateProjectionMatrix();
        } else fit("iso");
        // 외벽부터, 그다음 내벽 — Plan 순서대로
        const order = new Map(plan.walls.map((w, i) => [w.id, (w.kind === "exterior" ? 0 : 1000) + i]));
        wallMeshes.sort((a, b) => (order.get(a.name) ?? 1e6) - (order.get(b.name) ?? 1e6));
        api.current?.paint(selectedRef.current, reviewRef.current);
        setReady(true);
        if (!played.has(modelKey) && !reduce) {
          played.add(modelKey);
          startRise();
        }
      },
      undefined,
      () => onError?.("3D 모델을 불러오지 못했어요. 새로 고치거나 잠시 뒤 다시 열어 주세요."),
    );

    // ── 세우기 시연 ──
    let rise: { t0: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const applyRise = (t: number) => {
      if (!rise) return;
      const k = easeInOut(clamp01((t - RISE.camA) / (RISE.camB - RISE.camA)));
      camera.position.lerpVectors(rise.fromPos, rise.toPos, k);
      controls.target.copy(rise.target);
      camera.lookAt(rise.target);
      const step = wallMeshes.length > 1 ? RISE.wallSpan / (wallMeshes.length - 1) : 0;
      wallMeshes.forEach((m, i) => {
        m.scale.y = 0.02 + 0.98 * easeOut(clamp01((t - RISE.wallA - i * step) / RISE.wallDur));
      });
      openK = clamp01((t - RISE.openA) / RISE.openDur);
      api.current?.paint(selectedRef.current, reviewRef.current);
    };
    const endRise = () => {
      if (!rise) return;
      applyRise(RISE.end);
      rise = null;
      controls.enabled = true;
      controls.update();
    };
    const startRise = () => {
      fit("iso");
      const toPos = camera.position.clone();
      const target = controls.target.clone();
      fit("top"); // 처음은 위에서 본 평면 — 벽이 납작한 선으로 보인다
      rise = { t0: performance.now(), fromPos: camera.position.clone(), toPos, target };
      controls.enabled = false;
      applyRise(0);
    };

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // 누르기(끌지 않고 떼기) → 맞은 요소 고르기, 빈 곳이면 고르기 해제
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const cv = renderer.domElement;
    const pick = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // 문·창 상자가 벽 안에 있으므로 상자를 먼저 본다
      const hits = ray.intersectObjects(pickables, false);
      const opening = hits.find((h) => openingMats.has(h.object.name));
      return (opening ?? hits[0])?.object.name ?? null;
    };
    const onDown = (e: PointerEvent) => {
      if (rise) return endRise(); // 시연 중에 누르면 바로 끝
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) selectRef.current(pick(e));
      down = null;
    };
    const onMove = (e: PointerEvent) => {
      if (!e.buttons) cv.style.cursor = pick(e) ? "pointer" : "grab";
    };
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointermove", onMove);

    let raf = 0;
    const tick = () => {
      if (rise) {
        const t = (performance.now() - rise.t0) / 1000;
        if (t >= RISE.end) endRise();
        else applyRise(t);
      }
      if (!rise) controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    api.current = {
      setView: (v) => {
        endRise();
        fit(v);
      },
      setCut: (h) => {
        clip.constant = h;
      },
      paint: (sel, rev) => {
        for (const [id, mat] of wallMats) {
          mat.color.copy(id === sel ? colors.sel : rev.has(id) ? colors.wall.clone().lerp(colors.review, 0.35) : colors.wall);
          mat.emissive.copy(id === sel ? colors.sel : new THREE.Color(0)).multiplyScalar(id === sel ? 0.25 : 0);
        }
        for (const [id, m] of openingMats) {
          const c = id === sel ? colors.sel : rev.has(id) ? colors.review : m.base;
          m.line.color.copy(c);
          m.fill.color.copy(c);
          m.fill.opacity = (id === sel ? 0.45 : 0.18) * openK;
          m.line.opacity = openK;
        }
      },
      replay: () => {
        if (wallMeshes.length) startRise();
      },
    };

    return () => {
      endRise(); // 시연 중에 닫히면 끝난 모습의 시점을 기억한다
      lastCamera = { key: modelKey, pos: camera.position.clone(), target: controls.target.clone() };
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointermove", onMove);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      el.removeChild(cv);
      api.current = null;
    };
    // plan은 url(리비전)과 함께 바뀌므로 url만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 고른 것·확인 필요가 바뀌면 색만 다시 칠한다
  useEffect(() => {
    api.current?.paint(selected, review);
  }, [selected, review]);

  useEffect(() => {
    api.current?.setCut(cut + 0.0001); // 중괄호 필수: 값을 돌려주면 React가 정리 함수로 착각한다
  }, [cut]);

  const views: [View, string][] = [["iso", "비스듬히"], ["top", "위에서"], ["front", "정면"]];
  // v0.2.1: 무대 아래 가장자리의 도구 줄(patterns C형 도구형, StageBar) — 넓은 화면에선 3D 위에 떠 있고, 좁은 화면에선 3D 아래로 내려온다
  return (
    <div className="relative">
      <div className="relative aspect-4/3">
        <div ref={host} className="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" role="img" aria-label="3D 모델 — 끌어서 돌리고, 휠로 확대하고, 벽·문·창을 눌러 골라요">
          {!ready ? <span className="absolute inset-0 grid place-items-center text-body-sm text-ink-3">3D 모델을 불러오는 중…</span> : null}
        </div>
        {overlay ? (
          // 좁은 화면: 왼쪽 위 보기 전환 아래 한 줄 / 넓은 화면: 오른쪽 위
          <span className="absolute top-14 right-3 left-3 border border-line bg-bg/90 px-3 py-1.5 text-label text-ink-2 backdrop-blur-md md:top-3 md:left-auto md:max-w-sm" role="status">{overlay}</span>
        ) : null}
      </div>
      <StageBar label="3D 도구" showLabel={false}>
        <Segmented
          label="시점"
          size="sm"
          value={view}
          onChange={(v) => {
            setView(v);
            api.current?.setView(v);
          }}
          options={views.map(([v, label]) => ({ value: v, label }))}
        />
        <label className="flex min-w-48 flex-1 items-center gap-3 text-label text-ink-2">
          <span className="shrink-0">단면 높이</span>
          <input
            type="range"
            min={0.1}
            max={maxH}
            step={0.05}
            value={cut}
            onChange={(e) => setCut(Number(e.target.value))}
            className="min-w-0 flex-1 accent-(--color-ink)"
            aria-valuetext={`${cut.toFixed(2)} m`}
          />
          <span className="w-14 shrink-0 text-right tabular-nums text-ink">{cut.toFixed(2)} m</span>
        </label>
        {ready && !reduce ? (
          <Button variant="text" size="sm" onClick={() => api.current?.replay()}>
            세우기 다시 보기
          </Button>
        ) : null}
      </StageBar>
    </div>
  );
}
