// 객체별 점검 — 인식 결과(Plan)의 벽·문·창을 하나씩 보고 "모양이 말이 안 되는 것"을 찾는다.
//
// 백엔드의 확인 필요(review_items)는 "모델이 자신 없어 한 것"이고,
// 여기는 "값 자체가 이상한 것"이다(벽 밖으로 나간 문, 겹친 창, 어디에도 안 붙은 벽 …).
// 둘 다 작업 화면의 "확인 필요" 목록에 요소별로 모아 보여 준다. 서버에 묻지 않고 브라우저에서 계산한다.
//
//   error = 이대로 3D·dxf를 만들면 틀린 모양이 된다 → 빨간색
//   warn  = 틀렸을 가능성이 높다 → 확인 필요 색
// 규칙을 바꾸면 scripts/test-checks.mjs(node --test)도 함께 고친다.
import type { Opening, Plan, Wall } from "./api";
import { wallDir, wallLength } from "./plan";

export type CheckLevel = "error" | "warn";
export type Check = {
  id: string; // 벽·문·창 ID, 도면 전체면 "plan"
  kind: "wall" | "door" | "window" | "plan";
  level: CheckLevel;
  code: string;
  title: string; // "벽 밖으로 나간 문"
  detail: string; // 측정값
  fix: string; // 어떻게 고치면 되는지
};

const mmTxt = (v: number) => `${Math.round(v).toLocaleString("ko-KR")} mm`;

/** 점 p가 벽 w의 몸통(중심선 ± tol)에 닿는가 */
function touches(p: { x: number; y: number }, w: Wall, tol: number) {
  const L = wallLength(w);
  if (L < 1) return Math.hypot(p.x - w.start.x, p.y - w.start.y) <= tol;
  const d = wallDir(w);
  const s = (p.x - w.start.x) * d.x + (p.y - w.start.y) * d.y; // 벽 방향 거리
  const o = Math.abs((p.x - w.start.x) * -d.y + (p.y - w.start.y) * d.x); // 벽에서 떨어진 거리
  return s >= -tol && s <= L + tol && o <= tol;
}

export function checkPlan(plan: Plan): Check[] {
  const out: Check[] = [];
  const walls = new Map(plan.walls.map((w) => [w.id, w]));

  // ── 벽 ──
  plan.walls.forEach((w) => {
    const L = wallLength(w);
    const base = { id: w.id, kind: "wall" as const };
    if (L < Math.max(w.thickness, 100))
      out.push({ ...base, level: "error", code: "wall_too_short", title: "너무 짧은 벽", detail: `길이 ${mmTxt(L)} · 두께 ${mmTxt(w.thickness)}`, fix: "글자나 가구를 벽으로 잘못 본 것일 수 있어요. 벽이 아니면 지워 주세요." });
    if (w.thickness < 50 || w.thickness > 600)
      out.push({ ...base, level: "warn", code: "wall_thickness", title: "벽 두께가 이상해요", detail: `두께 ${mmTxt(w.thickness)}`, fix: "보통 내벽 100~200mm, 외벽 150~300mm예요. 두께를 고치거나 축척을 확인해 주세요." });
    if (w.height < 1800 || w.height > 6000)
      out.push({ ...base, level: "warn", code: "wall_height", title: "벽 높이가 이상해요", detail: `높이 ${mmTxt(w.height)}`, fix: "한 층 벽 높이는 보통 2.2~3.0m예요." });

    // 끝이 다른 벽에 닿는지 (모서리·T자 접합)
    const others = plan.walls.filter((x) => x.id !== w.id);
    if (others.length && L >= Math.max(w.thickness, 100)) {
      const free = [w.start, w.end].filter((p) => !others.some((x) => touches(p, x, (w.thickness + x.thickness) / 2 + 60)));
      if (free.length === 2)
        out.push({ ...base, level: w.kind === "exterior" ? "error" : "warn", code: "wall_detached", title: "어느 벽에도 안 붙은 벽", detail: "양쪽 끝이 모두 떠 있어요", fix: "범례·가구·치수선을 벽으로 본 것일 수 있어요. 벽이 아니면 지워 주세요." });
      else if (free.length === 1 && w.kind === "exterior")
        out.push({ ...base, level: "error", code: "exterior_open", title: "외벽이 닫히지 않아요", detail: "한쪽 끝이 다른 벽에 닿지 않아요", fix: "외벽은 건물을 한 바퀴 감싸야 해요. 빠진 벽을 추가하거나 이 벽의 종류를 내벽으로 바꿔 주세요." });
    }
  });

  // 겹친 벽: 나란하고(방향 같음), 서로 가깝고, 길이의 절반 이상이 포개짐 → 짧은 쪽에 표시
  for (let i = 0; i < plan.walls.length; i++)
    for (let j = i + 1; j < plan.walls.length; j++) {
      const a = plan.walls[i], b = plan.walls[j];
      const La = wallLength(a), Lb = wallLength(b);
      if (La < 1 || Lb < 1) continue;
      const da = wallDir(a), db = wallDir(b);
      if (Math.abs(da.x * db.y - da.y * db.x) > 0.05) continue; // 나란하지 않음
      const off = Math.abs((b.start.x - a.start.x) * -da.y + (b.start.y - a.start.y) * da.x);
      if (off > (a.thickness + b.thickness) / 4) continue;
      const s0 = (b.start.x - a.start.x) * da.x + (b.start.y - a.start.y) * da.y;
      const s1 = (b.end.x - a.start.x) * da.x + (b.end.y - a.start.y) * da.y;
      const over = Math.min(La, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
      if (over > Math.min(La, Lb) * 0.5) {
        const short = La <= Lb ? a : b, long = La <= Lb ? b : a;
        out.push({ id: short.id, kind: "wall", level: "error", code: "wall_duplicate", title: "다른 벽과 겹쳐요", detail: `${long.id}와 ${mmTxt(over)} 겹침`, fix: "같은 벽이 두 번 인식된 것 같아요. 하나를 지워 주세요." });
      }
    }

  // ── 문·창 ──
  const byWall = new Map<string, Opening[]>();
  plan.openings.forEach((o) => byWall.set(o.wall_id, [...(byWall.get(o.wall_id) ?? []), o]));
  plan.openings.forEach((o) => {
    const base = { id: o.id, kind: o.type };
    const name = o.type === "door" ? "문" : "창";
    const w = walls.get(o.wall_id);
    if (!w) {
      out.push({ ...base, level: "error", code: "opening_no_wall", title: `붙은 벽이 없는 ${name}`, detail: `벽 ${o.wall_id}가 없어요`, fix: "지우거나 다른 벽으로 옮겨 주세요." });
      return;
    }
    const L = wallLength(w);
    const a = o.position - o.width / 2, b = o.position + o.width / 2;
    if (a < -1 || b > L + 1)
      out.push({ ...base, level: "error", code: "opening_outside", title: `벽 밖으로 나간 ${name}`, detail: `벽 길이 ${mmTxt(L)} · ${name} 범위 ${mmTxt(a)} ~ ${mmTxt(b)}`, fix: "위치를 벽 안쪽으로 옮기거나 폭을 줄여 주세요." });
    if (o.sill_height + o.height > w.height + 1)
      out.push({ ...base, level: "error", code: "opening_too_tall", title: `벽보다 높은 ${name}`, detail: `위 끝 ${mmTxt(o.sill_height + o.height)} · 벽 높이 ${mmTxt(w.height)}`, fix: "높이나 창대 높이를 줄여 주세요." });
    const other = (byWall.get(o.wall_id) ?? []).find((x) => x.id !== o.id && Math.abs(x.position - o.position) < (x.width + o.width) / 2 - 1);
    if (other)
      out.push({ ...base, level: "error", code: "opening_overlap", title: `다른 문·창과 겹친 ${name}`, detail: `${other.id}와 같은 자리`, fix: "하나를 지우거나 위치를 옮겨 주세요." });
    if (o.type === "door" && (o.width < 600 || o.width > 2400))
      out.push({ ...base, level: "warn", code: "door_width", title: "문 폭이 이상해요", detail: `폭 ${mmTxt(o.width)}`, fix: "문은 보통 700~1,800mm예요. 폭을 고치거나 축척을 확인해 주세요." });
    if (o.type === "window" && (o.width < 300 || o.width > 6000))
      out.push({ ...base, level: "warn", code: "window_width", title: "창 폭이 이상해요", detail: `폭 ${mmTxt(o.width)}`, fix: "창 폭을 고치거나 축척을 확인해 주세요." });
    if (o.type === "door" && o.sill_height > 0)
      out.push({ ...base, level: "warn", code: "door_sill", title: "바닥에서 떠 있는 문", detail: `바닥에서 ${mmTxt(o.sill_height)}`, fix: "문은 바닥에 닿아야 해요. 창이면 종류를 창으로 바꿔 주세요." });
  });

  // ── 도면 전체 ──
  if (plan.walls.length && !plan.walls.some((w) => w.kind === "exterior"))
    out.push({ id: "plan", kind: "plan", level: "warn", code: "no_exterior", title: "외벽이 하나도 없어요", detail: `벽 ${plan.walls.length}개가 모두 내벽·미상`, fix: "건물 바깥을 감싸는 벽의 종류를 외벽으로 바꿔 주세요." });
  if (plan.walls.length >= 4 && !plan.openings.some((o) => o.type === "door"))
    out.push({ id: "plan", kind: "plan", level: "warn", code: "no_door", title: "문이 하나도 없어요", detail: "들어갈 수 있는 문을 찾지 못했어요", fix: "벽을 골라 문을 추가해 주세요." });
  return out;
}

/** 요소별로 묶기 */
export function checksById(list: Check[]) {
  const m = new Map<string, Check[]>();
  list.forEach((c) => m.set(c.id, [...(m.get(c.id) ?? []), c]));
  return m;
}

/** 백엔드가 "도면에 평면이 여러 개"라고 알려 줬는가 (가장 큰 평면만 변환함 — autobim-be recognition) */
export const hasOtherPlans = (plan: Plan) => plan.review_items.some((r) => r.element_id === "plan" && /평면이 여러 개|several plans|multiple plans/i.test(r.message));
