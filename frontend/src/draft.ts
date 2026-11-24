// 고칠 내용(초안) — 사용자가 고친 것을 모아 두었다가 "적용"을 누르면 보충 입력(SupplementRequest) 하나로 보낸다.
//
// 왜 모아서 보내나: 보충 입력 한 번마다 서버가 3D·DXF를 다시 만든다(revision +1).
// 칸 하나 고칠 때마다 보내면 기다림이 길고 리비전만 늘어난다 → 여러 개를 고친 뒤 한 번에 적용.
import type { NewOpening, OpeningPatch, Plan, ScaleHint, SupplementRequest, WallPatch } from "./api";
import { DEFAULTS, elementName, findElement, KIND_LABEL, OPENING_LABEL, mm } from "./plan";

export type Draft = {
  scale: ScaleHint | null;
  walls: Record<string, Omit<WallPatch, "id">>;
  openings: Record<string, Omit<OpeningPatch, "id">>;
  remove: string[];
  addOpenings: NewOpening[];
  resolved: string[];
};

export const emptyDraft = (): Draft => ({ scale: null, walls: {}, openings: {}, remove: [], addOpenings: [], resolved: [] });

/** 벽을 지우면 그 벽의 문·창도 같이 지워진다(백엔드 규칙과 같게) */
export function removedSet(plan: Plan, d: Draft) {
  const s = new Set(d.remove);
  for (const o of plan.openings) if (s.has(o.wall_id)) s.add(o.id);
  return s;
}

export function changeCount(d: Draft) {
  return (
    (d.scale ? 1 : 0) +
    Object.keys(d.walls).length +
    Object.keys(d.openings).length +
    d.remove.length +
    d.addOpenings.length +
    d.resolved.length
  );
}

// ─── 고치기 동작 (모두 새 객체를 돌려준다 — React 상태는 직접 바꾸지 않는다) ─────

export function patchWall(d: Draft, id: string, p: Omit<WallPatch, "id">): Draft {
  return { ...d, walls: { ...d.walls, [id]: { ...d.walls[id], ...p } } };
}
export function patchOpening(d: Draft, id: string, p: Omit<OpeningPatch, "id">): Draft {
  return { ...d, openings: { ...d.openings, [id]: { ...d.openings[id], ...p } } };
}
export function toggleResolved(d: Draft, id: string): Draft {
  return { ...d, resolved: d.resolved.includes(id) ? d.resolved.filter((x) => x !== id) : [...d.resolved, id] };
}
/** 지우기: 그 요소(와 딸린 문·창)에 걸린 다른 고칠 내용은 함께 버린다 — 서버가 지운 요소를 참조하면 400 */
export function removeElement(plan: Plan, d: Draft, id: string): Draft {
  const gone = removedSet(plan, { ...d, remove: [...d.remove, id] });
  const keep = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k)));
  // 지운 벽으로 옮기려던 문·창은 옮기기만 취소한다(원래 벽에 남는다)
  const openings = Object.fromEntries(
    Object.entries(keep(d.openings))
      .map(([k, p]) => {
        if (!p.wall_id || !gone.has(p.wall_id)) return [k, p] as const;
        const { wall_id: _, ...rest } = p;
        return [k, rest] as const;
      })
      .filter(([, p]) => Object.keys(p).length),
  );
  // 지운 벽을 기준으로 한 축척도 함께 버린다
  const scale = d.scale && "reference" in d.scale && gone.has(d.scale.reference.wall_id) ? null : d.scale;
  return {
    ...d,
    scale,
    remove: [...d.remove.filter((x) => x !== id), id],
    walls: keep(d.walls),
    openings,
    resolved: d.resolved.filter((x) => !gone.has(x)),
    addOpenings: d.addOpenings.filter((o) => !gone.has(o.wall_id)),
  };
}
export const restoreElement = (d: Draft, id: string): Draft => ({ ...d, remove: d.remove.filter((x) => x !== id) });

// ─── 보내기 ──────────────────────────────────────────────────────────────

export function toRequest(d: Draft): SupplementRequest {
  const req: SupplementRequest = {};
  if (d.scale) req.scale = d.scale;
  const w = Object.entries(d.walls).map(([id, p]) => ({ id, ...p }));
  const o = Object.entries(d.openings).map(([id, p]) => ({ id, ...p }));
  if (w.length) req.walls = w;
  if (o.length) req.openings = o;
  if (d.remove.length) req.remove = d.remove;
  if (d.addOpenings.length) req.add_openings = d.addOpenings;
  if (d.resolved.length) req.resolved = d.resolved;
  return req;
}

// ─── 미리보기: 고칠 내용을 반영한 Plan (2D 도면에 바로 보여주기용, 서버에 보내지 않음) ───

export const NEW_PREFIX = "new-";

export function previewPlan(plan: Plan, d: Draft): Plan {
  const gone = removedSet(plan, d);
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, ...d.walls[w.id] })),
    openings: [
      ...plan.openings.map((o) => ({ ...o, ...d.openings[o.id] })),
      // 크기를 안 정한 새 문·창은 서버처럼 기본값으로 보여 준다(0으로 두면 안 보이고 "폭이 이상해요"가 떴다)
      ...d.addOpenings.map((n, i) => ({
        ...n,
        id: `${NEW_PREFIX}${i + 1}`,
        confidence: null,
        width: n.width ?? DEFAULTS[n.type].width,
        height: n.height ?? DEFAULTS[n.type].height,
        sill_height: n.sill_height ?? DEFAULTS[n.type].sill_height,
      })),
    ],
    review_items: plan.review_items.filter((r) => !gone.has(r.element_id)),
  };
}

// ─── 바뀔 내용 목록 (사람이 읽는 말) ────────────────────────────────────────

const FIELD: Record<string, string> = {
  thickness: "두께", height: "높이", kind: "종류", type: "종류", position: "위치", width: "폭", sill_height: "창대 높이", wall_id: "붙은 벽",
};
const val = (k: string, v: unknown) =>
  k === "kind" ? KIND_LABEL[v as keyof typeof KIND_LABEL] : k === "type" ? OPENING_LABEL[v as keyof typeof OPENING_LABEL] : typeof v === "number" ? `${mm(v)}mm` : String(v);

export type Change = { key: string; text: string; undo: (d: Draft) => Draft };

export function changeList(plan: Plan, d: Draft): Change[] {
  const out: Change[] = [];
  const name = (id: string) => elementName(findElement(plan, id), id);
  if (d.scale) {
    const s = d.scale;
    const t = "building_width_mm" in s
      ? `건물 가로 길이 ${mm(s.building_width_mm)}mm로 크기 맞추기`
      : "reference" in s
        ? `${name(s.reference.wall_id)} 실제 길이 ${mm(s.reference.length_mm)}mm로 크기 맞추기`
        : `축척 ${s.mm_per_px}mm/px`;
    out.push({ key: "scale", text: t, undo: (x) => ({ ...x, scale: null }) });
  }
  for (const id of d.remove) {
    const cascade = plan.openings.filter((o) => o.wall_id === id).map((o) => o.id);
    out.push({
      key: `rm-${id}`,
      text: `${name(id)} 지우기${cascade.length ? ` (붙은 ${cascade.join(", ")} 함께)` : ""}`,
      undo: (x) => restoreElement(x, id),
    });
  }
  for (const [id, p] of Object.entries(d.walls)) {
    out.push({
      key: `w-${id}`,
      text: `${name(id)} ${Object.entries(p).map(([k, v]) => `${FIELD[k]} ${val(k, v)}`).join(", ")}`,
      undo: (x) => { const { [id]: _, ...rest } = x.walls; return { ...x, walls: rest }; },
    });
  }
  for (const [id, p] of Object.entries(d.openings)) {
    out.push({
      key: `o-${id}`,
      text: `${name(id)} ${Object.entries(p).map(([k, v]) => `${FIELD[k]} ${val(k, v)}`).join(", ")}`,
      undo: (x) => { const { [id]: _, ...rest } = x.openings; return { ...x, openings: rest }; },
    });
  }
  d.addOpenings.forEach((n, i) =>
    out.push({
      key: `add-${i}`,
      text: `${name(n.wall_id)}에 ${OPENING_LABEL[n.type]} 추가 (시작점에서 ${mm(n.position)}mm)`,
      undo: (x) => ({ ...x, addOpenings: x.addOpenings.filter((_, j) => j !== i) }),
    }),
  );
  for (const id of d.resolved) out.push({ key: `ok-${id}`, text: `${name(id)} 확인 완료`, undo: (x) => toggleResolved(x, id) });
  return out;
}
