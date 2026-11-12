// 도면 한 장에서 나온 건물들 — 평면 하나가 건물 하나로 세워지고, 끌어서 다른 건물 위에 놓으면 층으로 쌓인다.
//
// 왜 이렇게 하나: 한 장에 여러 층의 평면이 같이 그려져 있어도 도면에 층 표시가 없어 어느 평면이 몇 층인지 알 수 없다(백엔드도 모른다).
// 그래서 임의로 쌓지 않고 평면마다 따로 세워 보여 준 뒤, 사용자가 "이건 저 건물의 위층"이라고 알려 준다
// (계획서: 불확실한 것은 임의로 확정하지 않고 사용자에게 보충받는다).
//
// 상태는 주소(#s=…)에 다 들어 있다: 건물마다 층(작업 ID·층고·계단)의 목록. 새로 고쳐도, 주소를 보내도 같은 화면.
// 건물을 들여다보면 건물 화면(BuildingPage)이 그대로 열린다 — 층 확대·계단·위험 검토는 거기서.
import { lazy, Suspense, useMemo, useState } from "react";
import { Button, Select, cx } from "@design";
import { errorText, type Job } from "./api";
import { MAX_PLANS, renumber, siteLabels, stackOnto, unstack, type FloorModel, type FloorRef, type Site } from "./building";
import { BuildingPage, useFloorJobs } from "./BuildingPage";

const BuildingView = lazy(() => import("./BuildingView").then((m) => ({ default: m.BuildingView })));

const DRAG_TYPE = "application/x-autobim-stack";

export function SitePage({ site, onChange }: { site: Site; onChange: (s: Site) => void }) {
  const jobs = useFloorJobs(site.stacks.flat().map((f) => f.jobId));
  const [open, setOpen] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [said, setSaid] = useState(""); // 화면낭독기에 알릴 말(쌓았어요 · 떼었어요)

  const labels = siteLabels(site);
  const name = (i: number) => `건물 ${labels[i]}`;
  const stack = (from: number, to: number) => {
    if (from === to) return;
    const next = stackOnto(site, from, to);
    const at = to > from ? to - 1 : to; // from이 빠지면서 번호가 당겨진다
    setSaid(`${name(to)} 위에 ${name(from)}의 층을 올렸어요. 이제 ${next.stacks[at].length}개 층이에요.`);
    onChange(next);
  };

  // 건물 하나를 들여다보는 중 — 건물 화면을 그대로 쓴다
  if (open !== null && site.stacks[open]) {
    return (
      <BuildingPage
        key={open}
        title={name(open)}
        back={{ label: `건물 ${site.stacks.length}개 모두 보기`, onClick: () => setOpen(null) }}
        building={{ use: site.use, floors: site.stacks[open] }}
        onChange={(b) => {
          // 층을 다 빼면 그 건물은 없어진다
          const gone = !b.floors.length;
          if (gone) setOpen(null);
          onChange({ ...site, use: b.use, stacks: site.stacks.flatMap((st, i) => (i === open ? (gone ? [] : [b.floors]) : [st])), labels: labels.filter((_, i) => !(gone && i === open)) });
        }}
      />
    );
  }

  return (
    <div className="pt-6">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pb-5">
        <div className="min-w-0">
          <p className="eyebrow mb-2">도면 한 장 · 건물 <span className="tabular-nums">{site.stacks.length}</span>개</p>
          <h1 className="truncate font-display text-display-sm tracking-display">{site.sheet ?? "나눈 도면"}</h1>
        </div>
        <p className="max-w-md text-body-sm text-ink-2">
          평면마다 따로 세웠어요. 같은 건물의 다른 층이면 <b className="font-semibold text-ink">이름 줄을 끌어 다른 건물 위에 놓아</b> 층으로 쌓아 주세요.
        </p>
      </header>
      <p role="status" aria-live="polite" className="sr-only">{said}</p>

      <ul className={cx("grid gap-6", site.stacks.length > 1 && "lg:grid-cols-2")}>
        {site.stacks.map((floors, i) => (
          <StackCard
            key={floors.map((f) => f.jobId).join("+")}
            title={name(i)}
            floors={floors}
            jobs={jobs}
            others={site.stacks.map((_, k) => k).filter((k) => k !== i).map((k) => ({ value: String(k), label: `${name(k)} 위에 올리기` }))}
            dragging={dragging === i}
            target={over === i && dragging !== null && dragging !== i}
            canDrop={dragging !== null && dragging !== i}
            onDragStart={() => setDragging(i)}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onOver={(on) => setOver(on ? i : over === i ? null : over)}
            onDrop={(from) => { setDragging(null); setOver(null); stack(from, i); }}
            index={i}
            onStackOnto={(to) => stack(i, to)}
            onOpen={() => setOpen(i)}
            onUnstack={(fi) => { setSaid(`${floors[fi].name}을 떼어 따로 세웠어요.`); onChange(unstack(site, i, fi)); }}
            onMove={(fi, d) => {
              const a = [...floors];
              [a[fi], a[fi + d]] = [a[fi + d], a[fi]];
              onChange({ ...site, stacks: site.stacks.map((st, k) => (k === i ? renumber(a) : st)) });
            }}
          />
        ))}
      </ul>
      <p className="mt-6 text-label text-ink-3">
        한 장에서 평면을 {MAX_PLANS}개까지 나눠 세워요. 건물을 누르면 층별로 들여다보고 계단을 그리고 위험을 검토할 수 있어요. 이 주소를 저장해 두면 나중에 다시 열 수 있어요.
      </p>
    </div>
  );
}

function StackCard({ title, floors, jobs, others, dragging, target, canDrop, onDragStart, onDragEnd, onOver, onDrop, index, onStackOnto, onOpen, onUnstack, onMove }: {
  title: string; floors: FloorRef[]; jobs: Record<string, Job | null>; others: { value: string; label: string }[];
  dragging: boolean; target: boolean; canDrop: boolean; index: number;
  onDragStart: () => void; onDragEnd: () => void; onOver: (on: boolean) => void; onDrop: (from: number) => void;
  onStackOnto: (to: number) => void; onOpen: () => void; onUnstack: (fi: number) => void; onMove: (fi: number, d: -1 | 1) => void;
}) {
  const models: FloorModel[] = useMemo(
    () => floors.flatMap((f, i) => { const j = jobs[f.jobId]; return j?.plan ? [{ ...f, plan: j.plan, index: i }] : []; }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floors.map((f) => `${f.jobId}:${jobs[f.jobId]?.result_revision ?? "-"}:${f.heightMm}`).join(",")],
  );
  const ready = models.length === floors.length;
  const failed = floors.map((f) => jobs[f.jobId]).find((j) => j && j.status === "failed" && j.result_revision === null);
  const walls = models.reduce((n, f) => n + f.plan.walls.length, 0);
  const openings = models.reduce((n, f) => n + f.plan.openings.length, 0);

  return (
    <li
      className={cx("relative border-t border-ink transition-opacity duration-150", dragging && "opacity-40")}
      onDragOver={(e) => { if (canDrop && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOver(false); }}
      onDrop={(e) => { const from = Number(e.dataTransfer.getData(DRAG_TYPE)); e.preventDefault(); if (Number.isInteger(from)) onDrop(from); }}
    >
      {/* 이름 줄 = 끄는 손잡이. 3D는 끌면 돌아가므로 손잡이를 따로 둔다 */}
      <div
        draggable={others.length > 0}
        onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, String(index)); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
        onDragEnd={onDragEnd}
        className={cx("flex items-center justify-between gap-3 py-3", others.length > 0 && "cursor-grab active:cursor-grabbing")}
        title={others.length ? "끌어서 다른 건물 위에 놓으면 층으로 쌓여요" : undefined}
      >
        <p className="flex min-w-0 items-baseline gap-2">
          {others.length ? <span aria-hidden className="text-ink-3">⠿</span> : null}
          <span className="font-display text-title-lg tracking-title">{title}</span>
          <span className="text-label tabular-nums text-ink-3">{floors.length}개 층{ready ? ` · 벽 ${walls} · 문·창 ${openings}` : ""}</span>
        </p>
        <Button variant="secondary" size="sm" onClick={onOpen} disabledReason={!ready ? "도면을 읽는 중이에요" : undefined}>들여다보기</Button>
      </div>

      <div className="relative aspect-4/3 overflow-hidden stage-backdrop">
        {ready ? (
          <Suspense fallback={null}>
            <BuildingView floors={models} className="absolute inset-0" compactLabels fit={1.15} />
          </Suspense>
        ) : (
          <p className="grid size-full place-items-center px-6 text-center text-body-sm text-ink-3">
            {failed ? errorText(failed.error?.code ?? "", failed.error?.message) : floors.some((f) => jobs[f.jobId] === null) ? "작업을 찾을 수 없어요. 보관 기간이 지났을 수 있어요." : "벽·문·창을 읽는 중…"}
          </p>
        )}
        {target ? (
          <div className="pointer-events-none absolute inset-2 grid place-items-center border border-dashed border-ink bg-bg/75">
            <p className="font-display text-title-lg tracking-title">놓으면 {floors.length + 1}층부터 쌓여요</p>
          </div>
        ) : null}
      </div>

      {/* 층 목록(위층이 위) — 순서 바꾸기·떼어 내기. 끌기가 어려우면 아래 고르기로 쌓는다 */}
      <ol className="mt-2 divide-y divide-line" aria-label={`${title}의 층`}>
        {[...floors.keys()].reverse().map((fi) => {
          const f = floors[fi];
          const j = jobs[f.jobId];
          return (
            <li key={f.jobId} className="flex items-center gap-3 py-2 text-body-sm">
              <span className="w-8 shrink-0 font-display text-title tracking-title">{f.name}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">{j?.input.filename ?? "…"}</span>
              {floors.length > 1 ? (
                <>
                  <button type="button" disabled={fi === floors.length - 1} onClick={() => onMove(fi, 1)} aria-label={`${f.name} 한 층 위로`} className="size-8 text-ink-2 hover:text-ink disabled:opacity-30">↑</button>
                  <button type="button" disabled={fi === 0} onClick={() => onMove(fi, -1)} aria-label={`${f.name} 한 층 아래로`} className="size-8 text-ink-2 hover:text-ink disabled:opacity-30">↓</button>
                  <button type="button" onClick={() => onUnstack(fi)} className="shrink-0 text-label text-ink-3 underline-offset-4 hover:text-ink hover:underline">떼어 내기</button>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {others.length ? (
        <div className="mt-2 max-w-64">
          <Select label="끌지 않고 쌓기" value="" onChange={(e) => { if (e.target.value !== "") onStackOnto(Number(e.target.value)); }}
            options={[{ value: "", label: "다른 건물 위에 올리기…" }, ...others]} />
        </div>
      ) : null}
    </li>
  );
}
