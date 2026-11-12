// 작업 화면 — 인식 결과를 보고(3D·평면), 확인 필요 요소를 고치고, 적용해 다시 만들고, 파일을 받는다.
//
// 데이터 흐름 (한 방향):
//   job.plan (서버 결과) ─┬─▶ previewPlan(plan, draft) ─▶ 평면·속성 패널 (고칠 내용 미리보기)
//                        └─▶ 3D (서버가 만든 glb — 적용해야 바뀐다)
//   사용자가 고친 것 ─▶ draft ─(적용)─▶ POST /supplement ─▶ revision+1 ─▶ 폴링 ─▶ 새 job.plan·glb
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Badge, Button, PanelSection, Segmented, SpecList, TextField, cx, useToast } from "@design";
import { ApiError, downloadName, fileUrl, supplement, type Job, type Plan } from "./api";
import { PlanView } from "./PlanView";
import { Inspector } from "./Inspector";
import {
  OPENING_LABEL, REASON_LABEL, SCALE_LABEL, buildingWidthMm, elementName, findElement, mm, planBounds,
} from "./plan";
import { changeCount, changeList, emptyDraft, previewPlan, removedSet, toRequest, type Draft } from "./draft";
import { checkPlan, checksById, hasOtherPlans, type Check } from "./checks";

// three.js는 무거워서(약 600KB) 이 화면에서만 불러온다
const Viewer3D = lazy(() => import("./Viewer3D").then((m) => ({ default: m.Viewer3D })));

type Props = {
  job: Job; busy: boolean; track: (j: Job) => void; onRestart: () => void; onBuilding?: () => void;
  onSplit?: () => void; // 한 장에 평면이 여러 개일 때 — 나눠서 다시 올리기(SheetSplitter)
};
type KindFilter = "all" | "wall" | "door" | "window";

export function Workspace({ job, busy, track, onRestart, onBuilding, onSplit }: Props) {
  const plan = job.plan as Plan; // result_revision이 있으면 plan도 있다
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"3d" | "plan">("3d");
  const [applyErr, setApplyErr] = useState<string>();
  const [sending, setSending] = useState(false);
  const [viewerErr, setViewerErr] = useState<string>();
  const [kind, setKind] = useState<KindFilter>("all");

  const preview = useMemo(() => previewPlan(plan, draft), [plan, draft]);
  const removed = useMemo(() => removedSet(plan, draft), [plan, draft]);
  const reviewIds = useMemo(
    () => new Set(preview.review_items.map((r) => r.element_id).filter((id) => !draft.resolved.includes(id))),
    [preview, draft.resolved],
  );
  // 객체별 점검 — 고칠 내용이 반영된 Plan으로 계산해서, 값을 고치면 바로 사라진다(적용 전에도)
  const checks = useMemo(() => checkPlan(preview).filter((c) => !removed.has(c.id)), [preview, removed]);
  const checkMap = useMemo(() => checksById(checks), [checks]);
  const issueIds = useMemo(() => new Set(checks.filter((c) => c.level === "error" && c.id !== "plan").map((c) => c.id)), [checks]);
  const changes = useMemo(() => changeList(plan, draft), [plan, draft]);
  const pending = changeCount(draft);
  const rebuilding = job.result_revision !== job.revision; // 다시 만드는 중이거나, 마지막 적용이 실패함

  // 새 결과가 오면: 사라진 요소를 고르고 있었다면 고르기 해제
  useEffect(() => {
    if (selected && !findElement(plan, selected)) setSelected(null);
  }, [plan, selected]);

  const apply = async () => {
    setApplyErr(undefined);
    setSending(true);
    try {
      const next = await supplement(job.id, toRequest(draft));
      setDraft(emptyDraft()); // 서버가 받아들였으면(202) 초안은 비운다 — 이제 서버 기록에 쌓였다
      track(next);
      // 벽과 함께 지워진 문·창 알려 주기
      const cascade = next.removed.filter((r) => r.revision === next.revision && r.cascade_from);
      if (cascade.length) toast({ message: `${cascade.map((r) => r.id).join(", ")}도 벽과 함께 지워져요` });
    } catch (e) {
      setApplyErr(e instanceof ApiError ? e.message : "적용하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setSending(false);
    }
  };

  const glb = fileUrl(job, "glb");
  const b = planBounds(plan);
  const doors = plan.openings.filter((o) => o.type === "door").length;
  const planItems = preview.review_items.filter((r) => r.element_id === "plan" || r.element_kind === "dimension");
  const elementItems = preview.review_items.filter((r) => r.element_id !== "plan" && r.element_kind !== "dimension");

  const dxf = fileUrl(job, "dxf");
  const others = (["glb", "json"] as const).filter((k) => fileUrl(job, k));
  // 요소마다 한 줄: 백엔드가 자신 없어 한 것(review) + 값이 이상한 것(checks). 오류가 있는 요소가 먼저
  const rows = useMemo(() => {
    const ids = [...new Set([...checks.filter((c) => c.id !== "plan").map((c) => c.id), ...elementItems.map((r) => r.element_id)])];
    return ids
      .map((id) => {
        const el = findElement(preview, id);
        const k: Exclude<KindFilter, "all"> = el?.kind === "opening" ? el.el.type : "wall";
        const cs = checkMap.get(id) ?? [];
        return { id, el, kind: k, checks: cs, reviews: elementItems.filter((r) => r.element_id === id), error: cs.some((c) => c.level === "error") };
      })
      .sort((a, b) => Number(b.error) - Number(a.error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, preview]);
  const isDone = (r: (typeof rows)[number]) => !r.checks.length && draft.resolved.includes(r.id);
  const shownRows = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
  const left = rows.filter((r) => !isDone(r)).length;
  const planChecks = checkMap.get("plan") ?? [];
  const selChecks = selected ? checkMap.get(selected) ?? [] : [];

  return (
    <div className="pt-6">
      {/* 제목 줄: 파일 이름 · 리비전 | 받기 — 주 버튼은 하나(.dxf), 고칠 내용이 남으면 주 버튼은 "적용"으로 넘어간다 */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pb-5">
        <div className="min-w-0">
          <p className="eyebrow mb-2">인식 결과 · 리비전 <span className="tabular-nums">{job.result_revision}</span></p>
          <h1 className="truncate font-display text-display-sm tracking-display">{job.input.filename}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {others.length ? (
            <p className="flex items-center gap-3 text-body-sm text-ink-3">
              <span>다른 형식</span>
              {others.map((k) => (
                <a key={k} href={fileUrl(job, k)!} download={downloadName(job, k)} className="text-ink-2 underline-offset-4 hover:text-ink hover:underline">.{k}</a>
              ))}
            </p>
          ) : null}
          {onBuilding ? <Button variant="secondary" onClick={onBuilding}>건물로 보기 · 위층 추가</Button> : null}
          {dxf ? (
            <Button href={dxf} download={downloadName(job, "dxf")} variant={pending === 0 ? "primary" : "secondary"}>
              .dxf 받기 <span className={cx("text-label", pending === 0 ? "opacity-80" : "text-ink-3")}>벽별 블록</span>
            </Button>
          ) : null}
          {onSplit ? <Button variant="text" onClick={onSplit}>도면 나누기</Button> : null}
          <Button variant="text" onClick={onRestart}>다른 도면</Button>
        </div>
      </header>

      {/* 다시 만드는 중 / 마지막 적용 실패 — 상자 대신 한 줄 */}
      {rebuilding ? (
        <p role="status" className={cx("flex items-center gap-2 border-t py-3 text-body-sm", job.status === "failed" ? "border-danger text-danger" : "border-line text-ink-2")}>
          <span aria-hidden className={cx("size-2 shrink-0 rounded-full", job.status === "failed" ? "bg-danger" : "bg-ink-3")} />
          {job.status === "failed"
            ? `리비전 ${job.revision}을 만들지 못했어요 — ${job.error?.message ?? ""}. 지금 보이는 것은 리비전 ${job.result_revision} 결과예요.`
            : `리비전 ${job.revision}을 만드는 중이에요. 끝날 때까지 리비전 ${job.result_revision}을 보여 줘요.`}
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-12">
        {/* 왼쪽: 무대(3D · 평면). 테두리 상자 없이 바탕색만, 보기 전환은 무대 위 왼쪽 위 */}
        <section aria-label="보기" className="min-w-0 lg:col-span-8">
          <div className={cx("relative", tab === "3d" ? "stage-backdrop" : "bg-surface")}>
            <div className="absolute top-3 left-3 z-20">
              <Segmented
                label="보기"
                floating
                size="sm"
                value={tab}
                onChange={setTab}
                options={[{ value: "3d", label: "3D" }, { value: "plan", label: "평면", count: pending || undefined }]}
              />
            </div>
            {tab === "3d" ? (
              glb && !viewerErr ? (
                <Suspense fallback={<div className="aspect-4/3" />}>
                  <Viewer3D
                    url={glb}
                    modelKey={job.id}
                    plan={plan}
                    selected={selected}
                    review={reviewIds}
                    issues={issueIds}
                    onSelect={setSelected}
                    onError={setViewerErr}
                    overlay={busy ? `리비전 ${job.revision} 만드는 중…` : pending ? "고친 내용은 평면에 먼저 보이고, 3D는 적용하면 바뀌어요" : null}
                  />
                </Suspense>
              ) : (
                <p className="grid aspect-4/3 place-items-center p-6 text-center text-body-sm text-ink-3">{viewerErr ?? "3D 파일이 없어요."}</p>
              )
            ) : (
              <div className="aspect-4/3 px-3 pt-14 pb-3">
                <PlanView plan={preview} removed={removed} review={reviewIds} risky={issueIds} selected={selected} onSelect={setSelected} />
              </div>
            )}
          </div>
          {/* 무대 아래: 색 약속 + 수치 한 줄 */}
          <Legend />
          <SpecList
            layout="row"
            className="mt-5"
            items={[
              { label: "크기", value: `${(b.w / 1000).toFixed(2)} × ${(b.h / 1000).toFixed(2)}`, unit: "m" },
              { label: "벽", value: plan.walls.length, unit: "개" },
              { label: "문 · 창", value: `${doors} · ${plan.openings.length - doors}`, unit: "개" },
              { label: "축척", value: SCALE_LABEL[plan.scale.source], note: plan.scale.estimated ? "추정값 — 오른쪽에서 맞춰요" : undefined },
            ]}
          />
        </section>

        {/* 오른쪽 패널 하나: 번호 붙은 묶음을 선으로 나눈다 */}
        <aside aria-label="확인하고 고치기" className="min-w-0 lg:col-span-4">
          {/* 평면이 여러 개인 도면 알림 (백엔드는 가장 큰 평면만 변환) */}
          {hasOtherPlans(plan) && onSplit ? (
            <div role="status" className="mb-5 border-t-2 border-(--color-review) pt-4">
              <p className="text-body-sm font-semibold text-ink">이 도면에는 평면이 여러 개 있어요</p>
              <p className="mt-1 text-body-sm text-ink-2">지금은 가장 큰 평면 하나만 변환했어요. 평면마다 나눠 올리면 각각 건물로 세우고, 같은 건물의 층이면 쌓아 볼 수 있어요.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={onSplit}>도면 나누기</Button>
            </div>
          ) : null}
          <ScalePanel plan={plan} draft={draft} setDraft={setDraft} items={planItems} />

          <PanelSection n="02" title="고른 요소">
            {selected ? (
              <>
                {selChecks.length ? <CheckNotes checks={selChecks} className="mb-4" /> : null}
                <Inspector plan={plan} preview={preview} draft={draft} setDraft={setDraft} id={selected} onSelect={setSelected} />
              </>
            ) : (
              <p className="text-body-sm text-ink-3">3D나 평면에서 벽·문·창을 누르면 여기서 값을 고칠 수 있어요.</p>
            )}
          </PanelSection>

          <PanelSection n="03" title="확인 필요" meta={`${left}개 남음`}>
            {planChecks.length ? <CheckNotes checks={planChecks} className="mb-3" /> : null}
            {rows.length ? (
              <>
                {/* 객체 종류별로 걸러 보기 — 숫자는 그 종류에서 걸린 요소 수 */}
                <Segmented
                  label="종류"
                  size="sm"
                  value={kind}
                  onChange={setKind}
                  className="mb-2"
                  options={([["all", "전체"], ["wall", "벽"], ["door", "문"], ["window", "창"]] as const).map(([v, label]) => ({
                    value: v, label, count: (v === "all" ? rows : rows.filter((r) => r.kind === v)).length || undefined,
                  }))}
                />
                <ul className="divide-y divide-line">
                  {shownRows.map((r) => {
                    const done = isDone(r);
                    const open = selected === r.id;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(open ? null : r.id)}
                          aria-pressed={open}
                          className={cx("flex w-full items-baseline gap-3 py-3 text-left transition-colors duration-150 hover:bg-surface-2 aria-pressed:bg-surface-2", done && "text-ink-3")}
                        >
                          <span aria-hidden className={cx("size-2 shrink-0 rounded-full", done ? "bg-line-strong" : r.error ? "bg-(--color-risk)" : "bg-(--color-review)")} />
                          <span className="min-w-0 flex-1">
                            <span className={cx("block text-body-sm font-medium", done && "line-through")}>{elementName(r.el, r.id)}</span>
                            {r.checks.map((c) => (
                              <span key={c.code} className="block text-label">
                                <span className={c.level === "error" ? "font-medium text-danger" : "text-ink-2"}>{c.title}</span>
                                <span className="text-ink-3"> · {c.detail}</span>
                              </span>
                            ))}
                            {r.reviews.map((v, i) => (
                              <span key={i} className="block text-label text-ink-3">{REASON_LABEL[v.reason]} · 신뢰도 <span className="tabular-nums">{Math.round(v.confidence * 100)}%</span></span>
                            ))}
                          </span>
                          {done ? <Badge>확인함</Badge> : r.error ? <Badge tone="danger">오류</Badge> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {!shownRows.length ? <p className="py-3 text-body-sm text-ink-3">이 종류에는 확인할 요소가 없어요.</p> : null}
              </>
            ) : (
              <p className="text-body-sm text-ink-3">벽·문·창을 하나씩 점검했어요. 확인할 요소가 없어요.</p>
            )}
          </PanelSection>

          <PanelSection n="04" title="바뀔 내용" meta={`${pending}개`}>
            {changes.length ? (
              <ul className="space-y-1.5">
                {changes.map((c) => (
                  <li key={c.key} className="flex items-baseline justify-between gap-3 text-body-sm">
                    <span className="text-ink-2">{c.text}</span>
                    <button type="button" className="shrink-0 text-label text-ink-3 underline-offset-4 hover:text-ink hover:underline" onClick={() => setDraft(c.undo(draft))}>
                      되돌리기
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body-sm text-ink-3">고친 내용이 없어요. 고친 뒤 한 번에 적용해요.</p>
            )}
            {applyErr ? <p className="mt-3 text-body-sm text-danger" role="alert">{applyErr}</p> : null}
            <div className="mt-5 flex gap-2">
              <Button
                onClick={apply}
                loading={sending}
                variant={pending ? "primary" : "secondary"}
                disabledReason={busy ? "다시 만드는 중이에요" : !pending ? "고친 내용이 없어요" : undefined}
                className="flex-1"
              >
                {busy ? "만드는 중…" : `적용해서 다시 만들기${pending ? ` (${pending})` : ""}`}
              </Button>
              {pending ? <Button variant="secondary" onClick={() => setDraft(emptyDraft())}>모두 취소</Button> : null}
            </div>
            <p className="mt-2 text-label text-ink-3">인식을 다시 하지 않고, 고친 값으로 3D와 .dxf만 다시 만들어요.</p>
          </PanelSection>

          <AllElements plan={plan} removed={removed} selected={selected} onSelect={setSelected} flagged={new Set(rows.filter((r) => !isDone(r)).map((r) => r.id))} errors={issueIds} />
        </aside>
      </div>
    </div>
  );
}

/** 색 약속 — 2D·3D가 같은 색을 쓴다 */
function Legend() {
  const items: [string, string, boolean?][] = [
    ["외벽", "bg-(--color-wall-ext)"],
    ["내벽", "bg-(--color-wall)"],
    ["문", "bg-(--color-door)"],
    ["창", "bg-(--color-window)"],
    ["확인 필요", "border-2 border-dashed border-(--color-review)", true],
    ["오류", "border-2 border-(--color-risk)", true],
    ["고른 것", "border-2 border-accent", true],
  ];
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-label text-ink-3" aria-label="색 설명">
      {items.map(([t, c]) => (
        <li key={t} className="flex items-center gap-2">
          <span aria-hidden className={cx("size-3", c)} />
          {t}
        </li>
      ))}
    </ul>
  );
}

/** 축척 — 추정이면 눈에 띄게, 건물 가로 길이로 맞추기 */
function ScalePanel({ plan, draft, setDraft, items }: { plan: Plan; draft: Draft; setDraft: (d: Draft) => void; items: Plan["review_items"] }) {
  const cur = draft.scale && "building_width_mm" in draft.scale ? draft.scale.building_width_mm : null;
  const [text, setText] = useState(cur ? String(cur / 1000) : "");
  const [err, setErr] = useState<string>();
  const est = plan.scale.estimated;
  const now = buildingWidthMm(plan);
  return (
    <PanelSection n="01" title={est ? "실제 크기를 추정했어요" : "실제 크기"} tone={est ? "review" : undefined} meta={est ? <Badge dot>추정</Badge> : undefined}>
      <p className="text-body-sm text-ink-2">
        {SCALE_LABEL[plan.scale.source]}. 지금 건물 가로 길이는 <span className="tabular-nums text-ink">{(now / 1000).toFixed(2)} m</span>예요.
        {est ? " 실제 길이를 알면 넣어 주세요 — 모든 치수가 그에 맞게 바뀌어요." : ""}
      </p>
      {items.map((r, i) => (
        <p key={i} className="mt-1 text-label text-ink-3">{REASON_LABEL[r.reason]}{r.message ? ` — ${r.message}` : ""}</p>
      ))}
      <form
        className="mt-3 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(text.replace(/,/g, ""));
          if (!Number.isFinite(v) || v <= 0) return setErr("0보다 큰 숫자로 넣어 주세요");
          setErr(undefined);
          // 사람은 m로 넣고, 서버에는 mm로 보낸다
          setDraft({ ...draft, scale: { building_width_mm: Math.round(v * 1000) } });
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label="건물 가로 길이"
            hideLabel
            inputMode="decimal"
            placeholder={`예: ${(now / 1000).toFixed(1)}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            trailing={<span className="text-label text-ink-3">m</span>}
            error={err}
            hint="가장 바깥 벽 중심선 사이, 가로 방향"
          />
        </div>
        <Button type="submit" variant="secondary">맞추기</Button>
      </form>
      {cur ? <p className="mt-2 text-label text-ink-2">적용하면 가로 <span className="tabular-nums">{mm(cur)}</span> mm로 맞춰요</p> : null}
    </PanelSection>
  );
}

/** 모든 요소 — 3D·평면을 쓰기 어려울 때(키보드 등) 목록으로 고르기 */
function AllElements({ plan, removed, selected, onSelect, flagged, errors }: { plan: Plan; removed: Set<string>; selected: string | null; onSelect: (id: string) => void; flagged: Set<string>; errors: Set<string> }) {
  return (
    <details className="border-t border-line py-5">
      <summary className="cursor-pointer text-body-sm font-medium text-ink-2 hover:text-ink">
        모든 벽·문·창 ({plan.walls.length + plan.openings.length})
      </summary>
      <ul className="mt-2 grid grid-cols-2 gap-1">
        {[...plan.walls.map((w) => ({ id: w.id, t: elementName({ kind: "wall", el: w }) })), ...plan.openings.map((o) => ({ id: o.id, t: `${OPENING_LABEL[o.type]} ${o.id}` }))].map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => onSelect(x.id)}
              aria-pressed={selected === x.id}
              className={cx("flex w-full items-center gap-2 px-2 py-1.5 text-left text-body-sm transition-colors duration-150 hover:bg-surface-2 aria-pressed:bg-ink aria-pressed:text-bg", removed.has(x.id) && "text-ink-3 line-through")}
            >
              {flagged.has(x.id) ? <span aria-label={errors.has(x.id) ? "오류" : "확인 필요"} className={cx("size-1.5 shrink-0 rounded-full", errors.has(x.id) ? "bg-(--color-risk)" : "bg-(--color-review)")} /> : null}
              {x.t}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** 점검에서 걸린 내용 — 무엇이 이상한지와 어떻게 고치는지 */
function CheckNotes({ checks, className }: { checks: Check[]; className?: string }) {
  return (
    <ul className={cx("space-y-2", className)}>
      {checks.map((c) => (
        <li key={c.code} className={cx("border-l-2 pl-3", c.level === "error" ? "border-(--color-risk)" : "border-(--color-review)")}>
          <p className="text-body-sm font-medium text-ink">{c.title} <span className="text-label font-normal text-ink-3">· {c.detail}</span></p>
          <p className="text-label text-ink-2">{c.fix}</p>
        </li>
      ))}
    </ul>
  );
}
