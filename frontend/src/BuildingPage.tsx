// 건물 화면 — 층을 쌓아 3D로 보고, 층을 골라 들여다보고, 계단을 그려 넣고, 용도에 맞춰 위험을 검토한다.
//
// 두 가지로 열린다
//   샘플(#sample): 코드에 들어 있는 3층 샘플. 서버 없이 바로 시연.
//   내 건물(#b=…): 층마다 올린 도면의 작업 ID + 층고·계단·용도. 주소에 다 들어 있어 새로 고쳐도 남는다.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, PanelSection, Segmented, Select, SpecList, StageBar, TextField, cx } from "@design";
import { createJob, getJob, ApiError, errorText, ACCEPT, MAX_UPLOAD_MB, fileUrl, downloadName, type Job } from "./api";
import {
  USE_LABEL, SLAB_MM, buildingHash, effectiveStairs, defaultFloorHeight, nextStairId, stairDims, stairRiseTread,
  type Building, type FloorModel, type FloorRef, type Stair, type UseKey,
} from "./building";
import { LEVEL_LABEL, STAIR_STD, review, type Finding } from "./rules";
import { RISK_PIN, elementLabel, groupFindings, sortFindings } from "./riskPin";
import { ALL_LAYERS, LAYER_LABEL, type Layer } from "./BuildingView";
import { PlanView } from "./PlanView";
import { retryable } from "./useJob";

const BuildingView = lazy(() => import("./BuildingView").then((m) => ({ default: m.BuildingView })));

type Props = {
  sample?: FloorModel[]; building?: Building; onChange?: (b: Building) => void;
  title?: string; // 도면 한 장에서 나온 건물이면 "건물 A"
  back?: { label: string; onClick: () => void }; // 건물 모두 보기로 돌아가기(SitePage)
};

export function BuildingPage({ sample, building, onChange, title, back }: Props) {
  // 샘플은 화면 안에서만 고친다(주소에 안 남음)
  const [sampleState, setSampleState] = useState<{ use: UseKey; floors: FloorModel[] } | null>(sample ? { use: "apartment", floors: sample } : null);
  const jobs = useFloorJobs(building?.floors.map((f) => f.jobId) ?? []);

  const use: UseKey = sampleState?.use ?? building?.use ?? "apartment";
  const refs: FloorRef[] = sampleState?.floors ?? building?.floors ?? [];
  const floors: FloorModel[] = useMemo(
    () =>
      (sampleState
        ? sampleState.floors
        : refs.flatMap((f, i) => {
            const j = jobs[f.jobId];
            return j?.plan ? [{ ...f, plan: j.plan, index: i }] : [];
          })
      // 사용자가 그린 계단이 없으면 인식된 계단실에서 만든 후보를 쓴다(확인 필요)
      ).map((f) => ({ ...f, stairs: effectiveStairs(f, STAIR_STD[use].riser) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sampleState, building, jobs, use],
  );
  const ready = floors.length === refs.length && floors.length > 0;

  const update = (next: { use?: UseKey; floors?: FloorRef[] }) => {
    if (sampleState) setSampleState({ use: next.use ?? sampleState.use, floors: (next.floors as FloorModel[]) ?? sampleState.floors });
    else if (building) onChange?.({ use: next.use ?? building.use, floors: next.floors ?? building.floors });
  };
  const setFloor = (i: number, patch: Partial<FloorRef>) => update({ floors: refs.map((f, k) => (k === i ? { ...f, ...patch } : f)) });

  const [layers, setLayers] = useState<Record<Layer, boolean>>({ wall: true, door: true, window: true, floor: true, stair: true, space: true });
  const [focus, setFocus] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scanToken, setScanToken] = useState(0);
  const [drawFloor, setDrawFloor] = useState<number | null>(null);
  const [stairSel, setStairSel] = useState<string | null>(null);
  // 계단 그리기 창의 되돌리기: 바꾸기 직전의 계단 목록(주소에 저장되는 원래 값)을 차례로 쌓는다.
  // 취소 = 창을 연 순간의 계단으로 돌아가고 닫기
  const [stairHist, setStairHist] = useState<Stair[][]>([]);
  const stairStart = useRef<Stair[] | null>(null);
  const openStairs = (i: number) => {
    setDrawFloor(i);
    setStairSel(null);
    setStairHist([]);
    stairStart.current = refs[i]?.stairs ?? [];
  };
  const setStairs = (stairs: Stair[]) => {
    if (drawFloor === null || !refs[drawFloor]) return;
    setFloor(drawFloor, { stairs });
  };
  const undoStairs = () => {
    const prev = stairHist[stairHist.length - 1];
    if (!prev) return;
    setStairHist(stairHist.slice(0, -1));
    setStairs(prev);
  };
  const cancelStairs = () => {
    if (stairHist.length && stairStart.current) setStairs(stairStart.current);
    setStairHist([]);
    setDrawFloor(null);
  };

  // 3D가 다시 지어지는 건 층·계단·층고가 바뀔 때만 — 위험 결과는 그때마다 다시 계산
  const shapeKey = JSON.stringify(floors.map((f) => [f.jobId, f.heightMm, f.stairs, f.plan.walls.length]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableFloors = useMemo(() => floors, [shapeKey]);
  // 층 → 법규 먼저로 정렬해 요소별로 묶는다. 3D 번호(BuildingView)도 같은 순서로 붙어 목록 번호와 같다
  const findings = useMemo(() => (ready ? sortFindings(review(stableFloors, use)) : []), [stableFloors, use, ready]);
  const riskGroups = useMemo(() => groupFindings(findings), [findings]);
  const shownFindings = scanToken ? findings : [];
  const riskList = useRef<HTMLOListElement>(null);
  // 3D에서 번호·요소를 누르면 목록의 그 줄이 보이게
  useEffect(() => {
    if (selected) riskList.current?.querySelector<HTMLElement>('[aria-expanded="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const byKey = useMemo(() => new Map(findings.map((f) => [f.key, f])), [findings]);

  const sel = selected ? floors[Number(selected.split(":")[0])] : null;
  const selFindings = selected ? findings.filter((f) => f.key === selected) : [];

  return (
    <div className="pt-6">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pb-5">
        <div>
          {back ? <button type="button" onClick={back.onClick} className="mb-3 block text-label text-ink-3 underline-offset-4 hover:text-ink hover:underline">← {back.label}</button> : null}
          <p className="eyebrow mb-2">{sampleState ? "샘플 건물" : "내 건물"} · <span className="tabular-nums">{refs.length}</span>개 층</p>
          <h1 className="font-display text-display-sm tracking-display">{sampleState ? "샘플 주택" : title ?? "건물 보기"}</h1>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Select
              label="건물 용도"
              value={use}
              onChange={(e) => update({ use: e.target.value as UseKey })}
              options={(Object.keys(USE_LABEL) as UseKey[]).map((k) => ({ value: k, label: USE_LABEL[k] }))}
            />
          </div>
          <Button onClick={() => setScanToken((n) => n + 1)} disabledReason={!ready ? "층을 불러오는 중이에요" : undefined}>위험 검토</Button>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-12">
        {/* 무대: 테두리 상자 없이. 층 고르기는 왼쪽 위, 보이기는 아래 가장자리 도구 줄(StageBar — 좁은 화면에선 무대 아래로) */}
        <section aria-label="건물 3D" className="min-w-0 lg:col-span-8">
          <div className="relative stage-backdrop">
            <div className="relative aspect-4/3 overflow-hidden">
              {ready ? (
                <Suspense fallback={null}>
                  <BuildingView
                    floors={stableFloors}
                    className="absolute inset-0"
                    compactLabels
                    shiftY={0.04} /* 넓은 화면에서 아래 도구 줄(StageBar)에 건물 밑동이 닿지 않게 조금 올린다 */
                    layers={layers}
                    findings={shownFindings}
                    scanToken={scanToken}
                    focus={focus}
                    onFocus={(i) => { setFocus(i); setSelected(null); }}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </Suspense>
              ) : (
                <p className="grid size-full place-items-center text-body-sm text-ink-3">{refs.length ? "층 도면을 불러오는 중…" : "층을 추가해 주세요"}</p>
              )}
              {ready ? (
                <div className="absolute top-3 left-3 z-10">
                  <Segmented
                    label="층"
                    floating
                    size="sm"
                    value={focus === null ? "all" : String(focus)}
                    onChange={(v) => { setFocus(v === "all" ? null : Number(v)); setSelected(null); }}
                    options={[{ value: "all", label: "전체" }, ...floors.map((f, i) => ({ value: String(i), label: f.name }))]}
                  />
                </div>
              ) : null}
            </div>
            {ready ? (
              // 켜고 끄기 여섯 개 — 알약(Chip)은 다 켜져 있을 때 진한 테두리 여섯 개가 소재보다 무거웠다 → 작은 체크 상자
              <StageBar label="보이기">
                {ALL_LAYERS.map((k) => (
                  <Checkbox key={k} size="sm" label={LAYER_LABEL[k]} checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                ))}
              </StageBar>
            ) : null}
          </div>
          <p className="mt-3 text-label text-ink-3">
            {scanToken && riskGroups.length ? "빨간 번호를 누르면 그 층으로 다가가고, 위험 목록에 이유가 펼쳐져요 · " : ""}
            층을 누르면 그 층으로 다가가요 · 벽·문·창·바닥·계단에 커서를 올리면 이름과 치수, 위험이면 이유가 나와요 · Esc로 전체
          </p>

          {/* 고른 요소(위험이 없는 것) — 위험이 있는 요소는 오른쪽 목록 그 줄에 이유가 펼쳐진다 */}
          {selected && sel && !selFindings.length ? (
            <PanelSection title={selected.split(":")[1] === "floor" ? `${sel.name} 바닥` : `${sel.name} · ${selected.split(":")[1]}`} className="mt-6">
              <p className="text-body-sm text-ink-3">이 요소에는 걸린 위험이 없어요.</p>
            </PanelSection>
          ) : null}
        </section>

        <aside aria-label="검토와 층" className="min-w-0 lg:col-span-4">
          <PanelSection n="01" title="위험 요소" meta={scanToken ? <><span className="tabular-nums">{findings.length}</span>건 · {USE_LABEL[use]} 기준</> : undefined}>
            {!scanToken ? (
              <p className="text-body-sm text-ink-3">건물 용도를 고르고 "위험 검토"를 누르면, 기준에 못 미치는 곳을 빨갛게 표시해요.</p>
            ) : riskGroups.length ? (
              // 요소마다 한 줄: 번호(3D와 같음) · 층과 요소 → 걸린 기준들(측정값 → 기준). 누르면 그 층으로 다가가고 이유·근거가 펼쳐진다
              <ol ref={riskList} className="divide-y divide-line" aria-label="위험 요소 목록">
                {riskGroups.map((g, i) => {
                  const f0 = g[0];
                  const open = selected === f0.key;
                  return (
                    <li key={f0.key}>
                      <button
                        type="button"
                        data-risk-row
                        aria-expanded={open}
                        onClick={() => { if (open) setSelected(null); else { setFocus(f0.floor); setSelected(f0.key); } }}
                        className="flex w-full items-start gap-3 py-3.5 text-left transition-colors duration-150 hover:bg-surface-2 aria-expanded:bg-surface-2"
                      >
                        <span aria-hidden className={cx(RISK_PIN, "mt-px")}>{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-body-sm font-semibold text-ink">{floors[f0.floor]?.name} · {elementLabel(f0)}</span>
                            <span className="shrink-0 text-label tabular-nums text-ink-3">{g.length}건</span>
                          </span>
                          <span className="mt-2 block space-y-2">
                            {g.map((f, k) => (
                              <span key={k} className="block">
                                <span className="flex items-baseline justify-between gap-2">
                                  <span className="text-body-sm text-ink">{f.title}</span>
                                  <span className={cx("shrink-0 text-label", f.level === "law" ? "font-medium text-danger" : "text-ink-3")}>{LEVEL_LABEL[f.level]}</span>
                                </span>
                                <span className="block text-label tabular-nums text-ink-2">
                                  <span className="font-medium text-danger">{f.measured}</span> → 기준 {f.standard}
                                </span>
                                {open ? (
                                  <>
                                    <span className="mt-1 block text-label text-ink-2">{f.why}</span>
                                    <span className="mt-0.5 block text-label text-ink-3">근거: {f.basis}</span>
                                  </>
                                ) : null}
                              </span>
                            ))}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-body-sm text-ink-3">기준에 못 미치는 곳을 찾지 못했어요.</p>
            )}
            <p className="mt-3 text-caption text-ink-3">
              참고용 검토예요. 법률 자문이 아니고, 법령은 바뀔 수 있으니 국가법령정보센터 원문으로 확인해 주세요. 계단 기준({USE_LABEL[use]}): 폭 {STAIR_STD[use].width / 10}cm 이상 · 단높이 {STAIR_STD[use].riser / 10}cm 이하 · 단너비 {STAIR_STD[use].tread / 10}cm 이상.
            </p>
          </PanelSection>

          <PanelSection n="02" title="층" meta={<><span className="tabular-nums">{refs.length}</span>개</>}>
            <ul className="border-t border-line">
              {refs.map((f, i) => (
                <FloorRow key={`${f.jobId}-${i}`} f={f} autoStairs={floors[i]?.stairs.filter((x) => "auto" in x && x.auto).length ?? 0} i={i} n={refs.length} job={sampleState ? null : jobs[f.jobId]} sample={!!sampleState}
                  onPatch={(p) => setFloor(i, p)}
                  onMove={(d) => { const a = [...refs]; [a[i], a[i + d]] = [a[i + d], a[i]]; update({ floors: a.map((x, k) => ({ ...x, name: `${k + 1}F` })) }); }}
                  onRemove={() => update({ floors: refs.filter((_, k) => k !== i).map((x, k) => ({ ...x, name: `${k + 1}F` })) })}
                  onDrawStair={() => openStairs(i)} />
              ))}
            </ul>
            {!sampleState ? <AddFloor onAdded={(job) => update({ floors: [...refs, { jobId: job.id, name: `${refs.length + 1}F`, heightMm: 2900, stairs: [] }] })} /> : null}
          </PanelSection>
        </aside>
      </div>

      {/* 계단 그리기 — 도구 창(Dialog xl): 포커스 가두기·Esc·닫으면 누른 버튼으로 포커스가 돌아간다. 닫혀 있어도 붙여 둔다(돌아갈 자리를 기억하게) */}
      <StairEditor
        floor={drawFloor !== null ? floors[drawFloor] ?? null : null}
        risky={new Set(findings.filter((x) => x.floor === drawFloor).map((x) => x.elementId))}
        selected={stairSel}
        setSelected={setStairSel}
        onChange={(stairs) => {
          if (drawFloor === null || !refs[drawFloor]) return;
          setStairHist([...stairHist, refs[drawFloor].stairs]);
          setStairs(stairs.map(({ auto: _auto, ...st }: Stair & { auto?: boolean }) => st));
        }}
        onClose={() => { setStairHist([]); setDrawFloor(null); }}
        undoCount={stairHist.length}
        onUndo={undoStairs}
        onCancel={cancelStairs}
        use={use}
        byKey={byKey}
      />
    </div>
  );
}

function FloorRow({ f, autoStairs, i, n, job, sample, onPatch, onMove, onRemove, onDrawStair }: {
  f: FloorRef; autoStairs: number; i: number; n: number; job: Job | null | undefined; sample: boolean;
  onPatch: (p: Partial<FloorRef>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onDrawStair: () => void;
}) {
  const [h, setH] = useState(String(f.heightMm / 1000));
  useEffect(() => setH(String(f.heightMm / 1000)), [f.heightMm]);
  const status = sample ? null : !job ? "불러오는 중" : job.status === "failed" && job.result_revision === null ? errorText(job.error?.code ?? "", job.error?.message) : job.result_revision === null ? "인식 중" : null;
  const dxf = job ? fileUrl(job, "dxf") : null;
  return (
    <li className="border-b border-line py-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-baseline gap-2"><span className="font-display text-title tracking-title">{f.name}</span>{f.note ? <span className="text-label text-ink-3">{f.note}</span> : null}</p>
        <div className="flex gap-1">
          {!sample ? (
            <>
              <button type="button" disabled={i === 0} onClick={() => onMove(-1)} aria-label={`${f.name} 한 층 아래로`} className="size-8 text-ink-2 hover:text-ink disabled:opacity-30">↓</button>
              <button type="button" disabled={i === n - 1} onClick={() => onMove(1)} aria-label={`${f.name} 한 층 위로`} className="size-8 text-ink-2 hover:text-ink disabled:opacity-30">↑</button>
            </>
          ) : null}
        </div>
      </div>
      {status ? <p className="mt-1 text-label text-ink-3">{status}</p> : null}
      {autoStairs && !f.stairs.length ? (
        <p className="mt-1 flex items-baseline gap-1.5 text-label text-ink-2"><span aria-hidden className="size-2 shrink-0 rounded-full bg-(--color-review)" />인식된 계단실에서 계단 {autoStairs}개를 만들었어요 — 단 수·오르는 방향을 확인해 주세요</p>
      ) : null}
      <div className="mt-2 grid grid-cols-2 items-end gap-3">
        <TextField label="층고" inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)}
          onBlur={() => { const v = Number(h); if (v > 1.5 && v < 20) onPatch({ heightMm: Math.round(v * 1000) }); else setH(String(f.heightMm / 1000)); }}
          trailing={<span className="text-label text-ink-3">m</span>} hint={`바닥판 ${SLAB_MM}mm 포함`} />
        <Button variant="secondary" size="sm" onClick={onDrawStair}>계단 {f.stairs.length ? `${f.stairs.length}개 · 고치기` : autoStairs ? `${autoStairs}개 확인하기` : "그리기"}</Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 text-label">
        {!sample ? <a href={`#job-${f.jobId}`} className="text-ink-3 underline-offset-4 hover:text-ink hover:underline">이 층 벽·문·창 고치기</a> : null}
        {dxf && job ? <a href={dxf} download={downloadName(job, "dxf")} className="text-ink-3 underline-offset-4 hover:text-ink hover:underline">.dxf 받기</a> : null}
        {!sample ? <button type="button" onClick={onRemove} className="text-danger underline-offset-4 hover:underline">층 빼기</button> : null}
      </div>
    </li>
  );
}

function AddFloor({ onAdded }: { onAdded: (j: Job) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <div className="mt-3">
      <input ref={input} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return setErr(`파일이 너무 커요. ${MAX_UPLOAD_MB}MB 이하로 올려 주세요.`);
          setBusy(true); setErr(undefined);
          try { onAdded(await createJob(f)); } catch (x) { setErr(x instanceof ApiError ? x.message : "올리지 못했어요."); } finally { setBusy(false); }
        }} />
      <Button variant="secondary" block loading={busy} onClick={() => input.current?.click()}>위층 도면 올리기</Button>
      {err ? <p role="alert" className="mt-2 text-body-sm text-danger">{err}</p> : null}
    </div>
  );
}

/** 계단 그리기: 평면에서 끌어 사각형 → 단 수·오르는 방향 정하기 */
function StairEditor({ floor, risky, selected, setSelected, onChange, onClose, undoCount, onUndo, onCancel, use, byKey }: {
  floor: FloorModel | null; risky: Set<string>; selected: string | null; setSelected: (s: string | null) => void;
  onChange: (s: Stair[]) => void; onClose: () => void; use: UseKey; byKey: Map<string, Finding>;
  undoCount: number; onUndo: () => void; onCancel: () => void; // 되돌리기(Ctrl+Z, 한 단계) · 취소(창을 연 때로)
}) {
  const st = floor?.stairs.find((s) => s.id === selected) ?? null;
  const std = STAIR_STD[use];
  const set = (p: Partial<Stair>) => floor && st && onChange(floor.stairs.map((s) => (s.id === st.id ? { ...s, ...p } : s)));
  const open = floor !== null;
  /** 고른 계단 하나만 지운다(그린 순서와 상관없이). 지우기도 되돌리기로 되살릴 수 있다 */
  const removeStair = (id: string) => {
    if (!floor) return;
    onChange(floor.stairs.filter((s) => s.id !== id));
    if (selected === id) setSelected(null);
  };
  const removeRef = useRef(removeStair);
  removeRef.current = removeStair;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = st ? st.id : null; // 계단을 고른 때만 지운다
  // 키보드: Ctrl+Z(⌘Z) 되돌리기 · Delete/Backspace 고른 계단 지우기 — 글자 칸에서는 브라우저 기본 동작을 그대로 둔다
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        onUndo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        e.preventDefault();
        removeRef.current(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onUndo]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={floor ? `${floor.name} 계단 그리기` : "계단 그리기"}
      description="평면에서 계단 자리를 끌어 사각형으로 그려요. 다음 층 바닥까지 올라가는 곧은 계단으로 만들어요."
      actions={
        <>
          {/* 취소 = 이 창에서 바꾼 것을 모두 버리고 닫기. 바꾼 게 없으면 위의 닫기(X)와 같으므로 숨긴다 */}
          {undoCount ? <Button variant="text" onClick={onCancel}>취소</Button> : null}
          <Button onClick={onClose}>다 했어요</Button>
        </>
      }
    >
      {floor ? (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* 그리는 칸: 창 바탕(surface)보다 한 단계 어두운 무대 바탕 — 어디까지 그릴 수 있는지 보이게 */}
          <div className="aspect-4/3 bg-bg p-2 lg:col-span-8">
            <PlanView plan={floor.plan} removed={new Set()} review={new Set()} selected={selected} onSelect={setSelected} stairs={floor.stairs} risky={risky}
              onDrawStair={(r) => {
                const id = nextStairId(floor);
                const alongX = Math.abs(r.x1 - r.x0) >= Math.abs(r.y1 - r.y0);
                const steps = Math.max(3, Math.ceil(floor.heightMm / std.riser)); // 기준 단높이를 넘지 않게
                onChange([...floor.stairs, { id, ...r, steps, dir: alongX ? (r.x1 >= r.x0 ? "x+" : "x-") : (r.y1 >= r.y0 ? "y+" : "y-") }]);
                setSelected(id);
              }} />
          </div>
          <div className="space-y-4 lg:col-span-4">
            {/* 계단 목록 — 겹쳐 그려 평면에서 누르기 어려워도 여기서 고르고, 원하는 것만 바로 지운다 */}
            {floor.stairs.length ? (
              <ul className="divide-y divide-line border-y border-line" aria-label="이 층 계단">
                {floor.stairs.map((s) => {
                  const d = stairDims(s);
                  const on = s.id === st?.id;
                  return (
                    <li key={s.id} className={cx("flex items-center gap-3 py-2", on && "bg-surface-2")}>
                      <button type="button" onClick={() => setSelected(on ? null : s.id)} aria-pressed={on} className="flex min-w-0 flex-1 items-baseline gap-2 px-1 text-left">
                        <span className="text-body-sm font-medium">계단 {s.id}</span>
                        <span className="truncate text-label tabular-nums text-ink-3">{(d.width / 1000).toFixed(2)} × {(d.run / 1000).toFixed(2)} m · {s.steps}단</span>
                      </button>
                      <button type="button" onClick={() => removeStair(s.id)} aria-label={`계단 ${s.id} 지우기`} className="shrink-0 px-1 text-label text-danger underline-offset-4 hover:underline">
                        지우기
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {st ? (
              <>
                <h3 className="flex items-baseline gap-2">
                  <span className="font-display text-title-lg tracking-title">계단</span>{" "}
                  <span className="text-title tabular-nums text-ink-2">{st.id}</span>
                </h3>
                <SpecList dense items={[
                  { label: "폭", value: (stairDims(st).width / 1000).toFixed(2), unit: "m" },
                  { label: "길이", value: (stairDims(st).run / 1000).toFixed(2), unit: "m" },
                  { label: "단높이", value: Math.round(stairRiseTread(st, floor.heightMm).riser), unit: "mm" },
                  { label: "단너비", value: Math.round(stairRiseTread(st, floor.heightMm).tread), unit: "mm" },
                ]} />
                <StepsField key={st.id} value={st.steps} onCommit={(v) => set({ steps: v })}
                  hint={`${USE_LABEL[use]} 기준 단높이 ${std.riser}mm 이하 → ${Math.ceil(floor.heightMm / std.riser)}단 이상`} />
                <Select label="오르는 방향" value={st.dir} onChange={(e) => set({ dir: e.target.value as Stair["dir"] })}
                  options={[{ value: "x+", label: "오른쪽으로" }, { value: "x-", label: "왼쪽으로" }, { value: "y+", label: "위쪽으로" }, { value: "y-", label: "아래쪽으로" }]} />
                {[...byKey.values()].filter((f) => f.floor === floor.index && f.elementId === st.id).map((f, i) => (
                  <p key={i} className="text-body-sm text-danger">{f.title}: {f.measured} → {f.standard}</p>
                ))}
                <Button variant="danger" size="sm" onClick={() => removeStair(st.id)} aria-keyshortcuts="Delete">이 계단 지우기</Button>
                <p className="text-label text-ink-3">고른 계단은 Delete 키로도 지울 수 있어요. 잘못 지우면 Ctrl+Z로 살리거나 취소로 처음 상태로 돌아가요.</p>
              </>
            ) : (
              <p className="text-body-sm text-ink-3">계단을 그리거나 평면·목록에서 눌러 고르면 단 수와 방향을 정할 수 있어요.</p>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/** 단 수 칸: 지우고 다시 쓰는 중간 값("1")도 받아 두고, 칸에서 벗어나거나 Enter를 누를 때 확인해 반영한다 */
function StepsField({ value, onCommit, hint }: { value: number; onCommit: (v: number) => void; hint: string }) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string>();
  useEffect(() => setText(String(value)), [value]); // 되돌리기 등으로 바뀌면 칸도 따라간다
  const commit = () => {
    const v = Number(text);
    if (!Number.isInteger(v) || v < 2 || v > 200) return setErr("2~200 사이 정수로 넣어 주세요");
    setErr(undefined);
    if (v !== value) onCommit(v);
  };
  return (
    <TextField label="단 수" inputMode="numeric" value={text} error={err} hint={hint}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

/** 층마다 작업 상태를 불러오고, 아직 인식 중이면 따라간다 */
export function useFloorJobs(ids: string[]) {
  const [jobs, setJobs] = useState<Record<string, Job | null>>({});
  const key = ids.join(",");
  useEffect(() => {
    let stop = false;
    const timers: number[] = [];
    const load = async (id: string, n = 0) => {
      try {
        const j = await getJob(id);
        if (stop) return;
        setJobs((m) => ({ ...m, [id]: j }));
        if (j.status === "queued" || j.status === "running") timers.push(window.setTimeout(() => load(id, n + 1), Math.min(3000, 800 + n * 200)));
      } catch (e) {
        if (stop) return;
        // 잠깐 끊긴 것이면 마지막으로 받은 값을 두고 다시 묻는다. 작업이 없을 때(404)만 "찾을 수 없음"으로
        if (e instanceof ApiError && retryable(e)) timers.push(window.setTimeout(() => load(id, n + 1), 3000));
        else setJobs((m) => ({ ...m, [id]: null }));
      }
    };
    ids.forEach((id) => load(id));
    return () => { stop = true; timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return jobs;
}

export { buildingHash, defaultFloorHeight };
