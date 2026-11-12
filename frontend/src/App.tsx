// Auto-BIM 프론트 — 화면은 세 가지: 올리기 → 인식 중 → 작업(확인·고치기·받기)
// 결정: preset=calm · mode=light · accent=먹빛 남색(한 가지 의미: 지금 고른 것) — SITE_REQUEST.md
//
// 어느 화면을 보여줄지는 "작업(job)의 상태"로만 정한다. 화면 상태를 따로 들고 있지 않으면
// 새로 고침하거나 주소(#job-…)를 공유해도 같은 화면이 나온다.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, ProgressBar, SiteHeader, SpecList, Stepper, ToastProvider, cx } from "@design";
import { ACCEPT, ApiError, MAX_UPLOAD_MB, createJob, errorText } from "./api";
import { useJob } from "./useJob";
import { SAMPLE_FLOORS } from "./sampleBuilding";
import { MAX_PLANS, buildingFromHash, buildingHash, defaultFloorHeight, siteFromHash, siteHash, type Building, type Site } from "./building";
import { Workspace } from "./Workspace";
import { SheetSplitter } from "./SheetSplitter";
import { detectRegions, readImage, type Region } from "./sheet";

// 첫 화면의 3D 모형도 three.js를 쓰므로 나중에 불러온다
const BuildingView = lazy(() => import("./BuildingView").then((m) => ({ default: m.BuildingView })));
const BuildingPage = lazy(() => import("./BuildingPage").then((m) => ({ default: m.BuildingPage })));
const SitePage = lazy(() => import("./SitePage").then((m) => ({ default: m.SitePage })));

// 방금 올린 원본 그림(작업 ID → 파일). 결과 화면에서 "도면 나누기"를 누르면 다시 고르지 않고 바로 나눌 수 있게 — 새로 고치면 사라진다
const uploaded = new Map<string, File>();

const STEPS = ["도면 올리기", "벽·문·창 인식", "확인·고치기·받기"];

// 주소 #job-<작업 ID> — 결과를 다시 열거나 팀원에게 보낼 수 있게
const jobFromHash = () => (location.hash.match(/^#job-([0-9a-f]{32})$/) ?? [])[1] ?? null;
// 메뉴 페이지 — 첫 화면에는 글을 거의 두지 않고, 설명은 메뉴에서 찾아가게 한다
type Page = "home" | "how" | "about" | "sample";
const pageFromHash = (): Page => (location.hash === "#how" ? "how" : location.hash === "#about" ? "about" : location.hash === "#sample" ? "sample" : "home");

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [jobId, setJobId] = useState<string | null>(jobFromHash);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [building, setBuilding] = useState<Building | null>(buildingFromHash);
  const [site, setSite] = useState<Site | null>(siteFromHash);
  // 도면 나누기 창: ask = 올리기 전에 "평면이 여러 개 보여요"라고 물어보는 중(그대로 올리기도 가능)
  const [split, setSplit] = useState<{ file: File; regions: Region[] | null; ask: boolean } | null>(null);
  const [splitBusy, setSplitBusy] = useState<string | null>(null);
  const [splitErr, setSplitErr] = useState<string>();
  const repick = useRef<HTMLInputElement>(null);
  const { job, error, busy, track } = useJob(jobId);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string>();

  useEffect(() => {
    const onHash = () => {
      setJobId(jobFromHash());
      setPage(pageFromHash());
      setBuilding(buildingFromHash());
      setSite(siteFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** 그대로 한 장 올리기 */
  const uploadWhole = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const j = await createJob(file);
        uploaded.set(j.id, file);
        history.pushState(null, "", `#job-${j.id}`);
        setJobId(j.id);
        track(j);
        window.scrollTo({ top: 0 });
      } catch (e) {
        setUploadErr(e instanceof ApiError ? e.message : "올리지 못했어요. 다시 시도해 주세요.");
      } finally {
        setUploading(false);
      }
    },
    [track],
  );

  const onFile = useCallback(
    async (file: File) => {
      setUploadErr(undefined);
      // 브라우저에서 먼저 거른다 — 최종 판단은 서버(413·415)
      const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
      if (!ACCEPT.split(",").includes(ext)) return setUploadErr(errorText("unsupported_media_type"));
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return setUploadErr(`파일이 너무 커요. ${MAX_UPLOAD_MB}MB 이하로 올려 주세요.`);
      // 한 장에 평면이 여러 개로 보이면 먼저 물어본다(나눠 올리기 / 그대로 올리기). 못 읽는 형식·하나뿐이면 바로 올린다
      const img = await readImage(file);
      const regions = img ? detectRegions(img, MAX_PLANS) : [];
      img?.close();
      if (regions.length >= 2) return setSplit({ file, regions, ask: true });
      uploadWhole(file);
    },
    [uploadWhole],
  );

  /** 평면마다 자른 그림을 차례로 올리고(서버는 한 번에 하나씩 인식한다), 건물 여러 개 화면으로 간다 */
  const uploadParts = async (parts: File[]) => {
    if (!split) return;
    setSplitErr(undefined);
    try {
      const ids: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        setSplitBusy(`${i + 1} / ${parts.length} 올리는 중`);
        ids.push((await createJob(parts[i])).id);
      }
      const sheet = split.file.name;
      setSplit(null);
      if (ids.length === 1) location.hash = `#job-${ids[0]}`;
      else location.hash = siteHash({ use: "apartment", sheet, stacks: ids.map((id) => [{ jobId: id, name: "1F", heightMm: 2900, stairs: [] }]) });
    } catch (e) {
      setSplitErr(e instanceof ApiError ? e.message : "올리지 못했어요. 다시 시도해 주세요.");
    } finally {
      setSplitBusy(null);
    }
  };

  const trySample = useCallback(async () => {
    const res = await fetch("/sample/plan.png").catch(() => null);
    if (!res?.ok) return setUploadErr("샘플 평면도를 불러오지 못했어요.");
    onFile(new File([await res.blob()], "sample-plan.png", { type: "image/png" }));
  }, [onFile]);

  const restart = () => {
    history.pushState(null, "", location.pathname);
    setJobId(null);
    setBuilding(null);
    setSite(null);
    setUploadErr(undefined);
  };

  // ─── 지금 보여줄 화면 ───
  let content;
  if (!jobId && site) {
    content = (
      <Suspense fallback={null}>
        <SitePage site={site} onChange={(s2) => { history.replaceState(null, "", siteHash(s2)); setSite(s2); }} />
      </Suspense>
    );
  } else if (!jobId && building) {
    content = (
      <Suspense fallback={null}>
        <BuildingPage building={building} onChange={(b) => { history.replaceState(null, "", buildingHash(b)); setBuilding(b); }} />
      </Suspense>
    );
  } else if (!jobId && page === "sample") {
    content = (
      <Suspense fallback={null}>
        <BuildingPage sample={SAMPLE_FLOORS} />
      </Suspense>
    );
  } else if (!jobId && page === "how") {
    content = <HowPage />;
  } else if (!jobId && page === "about") {
    content = <AboutPage />;
  } else if (!jobId) {
    content = <UploadStage busy={uploading} error={uploadErr} onFile={onFile} onSample={trySample} />;
  } else if (error && !job) {
    content = (
      <EmptyState kind="error" className="pt-16" title="결과를 열 수 없어요" description={error.message}
        action={<Button onClick={restart}>도면 올리기</Button>} />
    );
  } else if (job && job.result_revision !== null) {
    content = (
      <Workspace key={job.id} job={job} busy={busy} track={track} onRestart={restart}
        onSplit={job.input.type === "image" ? () => {
          // 원본 그림이 아직 브라우저에 있으면 바로, 없으면(새로 고침·다른 사람이 연 주소) 다시 고르게 한다
          const f = uploaded.get(job.id);
          if (f) setSplit({ file: f, regions: null, ask: false });
          else repick.current?.click();
        } : undefined}
        onBuilding={() => {
          // 이 도면을 1층으로 하는 건물 — 위층은 건물 화면에서 추가
          const b: Building = { use: "apartment", floors: [{ jobId: job.id, name: "1F", heightMm: job.plan ? defaultFloorHeight(job.plan) : 2900, stairs: [] }] };
          location.hash = buildingHash(b);
        }} />
    );
  } else if (job?.status === "failed") {
    content = (
      <div className="pt-8">
        <Stepper steps={STEPS} current={1} className="mb-8" />
        <EmptyState kind="error" title="인식하지 못했어요" description={errorText(job.error?.code ?? "", job.error?.message)}
          action={<Button onClick={restart}>다른 도면 올리기</Button>} />
      </div>
    );
  } else {
    content = (
      <div className="pt-8">
        <Stepper steps={STEPS} current={1} className="mb-10" />
        <div className="max-w-lg">
          <p className="eyebrow mb-3">인식 중</p>
          <h1 className="font-display text-display-sm tracking-display">{job?.input.filename ?? "도면"}을 읽고 있어요</h1>
          <p className="mt-2 text-body-sm text-ink-2">벽·문·창을 찾아 3D와 .dxf를 만들어요. 이 주소를 저장해 두면 나중에 다시 열 수 있어요.</p>
          <ProgressBar
            className="mt-8"
            value={job?.status === "running" ? 60 : 15}
            label={job?.status === "running" ? "인식하고 3D를 만드는 중" : "차례를 기다리는 중"}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        brand={<a href="#" onClick={(e) => { e.preventDefault(); restart(); }} className="tracking-title">Auto-BIM</a>}
        items={[
          { label: "변환하기", href: "#", current: !jobId && !building && !site && page === "home" },
          { label: "샘플 건물", href: "#sample", current: !jobId && page === "sample" },
          { label: "사용법", href: "#how", current: !jobId && page === "how" },
          { label: "소개", href: "#about", current: !jobId && page === "about" },
        ]}
        menuLabel="메뉴"
        navAlign="center"
      />
      {/* 첫 화면은 무대가 화면 끝까지(container 밖), 나머지는 본문 폭 */}
      <main className={cx("flex-1", jobId || building || site || page !== "home" ? "container-page pb-24" : "")}>{content}</main>
      {/* 도면 나누기 — 닫혀 있어도 붙여 둔다(닫으면 누른 버튼으로 포커스가 돌아가게) */}
      <input ref={repick} type="file" accept=".png,.jpg,.jpeg,.bmp,.webp" className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setSplit({ file: f, regions: null, ask: false }); }} />
      <SheetSplitter
        file={split?.file ?? null}
        suggested={split?.regions}
        busy={splitBusy !== null}
        progress={splitBusy ?? undefined}
        error={splitErr}
        onSplit={uploadParts}
        onWhole={split?.ask ? () => { const f = split.file; setSplit(null); uploadWhole(f); } : undefined}
        onClose={() => { if (!splitBusy) { setSplit(null); setSplitErr(undefined); } }}
      />
      <footer className="border-t border-line">
        <div className="container-page flex flex-wrap justify-between gap-2 py-6 text-label text-ink-3">
          <span>로그인 없이 써요. 결과는 작업 주소를 아는 사람만 열 수 있어요.</span>
          <span>
            Auto-BIM · 가천대 AI P-실무프로젝트 2분반 3조 ·{" "}
            {/* 함께 배포되는 글꼴(SIL OFL 1.1)·라이브러리(MIT) 라이선스 전문 — 빌드 때 scripts/licenses.mjs가 만든다 */}
            <a href={`${import.meta.env.BASE_URL}licenses/THIRD_PARTY_LICENSES.txt`} className="underline underline-offset-4 hover:text-ink">글꼴·라이브러리 라이선스</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** 첫 화면 — 글은 거의 없이 가운데 3D 모형이 주인공. 할 수 있는 일은 "평면도 올리기" 하나. 설명은 메뉴(사용법·소개)로. */
function UploadStage({ busy, error, onFile, onSample }: { busy: boolean; error?: string; onFile: (f: File) => void; onSample: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // 화면 어디에 끌어다 놓아도 받는다
  useEffect(() => {
    let depth = 0;
    const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => { if (hasFile(e)) { depth++; setOver(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overFn = (e: DragEvent) => { if (hasFile(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [onFile]);

  return (
    <section aria-label="평면도 올리기" className="h-stage stage-backdrop relative overflow-hidden">
      <h1 className="sr-only">Auto-BIM — 평면도를 올리면 벽·문·창이 나뉜 3D로</h1>
      {/* 3D는 화면 끝까지(층이 세워지고 펼쳐진다), 글·버튼은 본문 폭에 맞춘다 */}
      <Suspense fallback={null}>
        <BuildingView floors={SAMPLE_FLOORS} className="absolute inset-0" compactLabels fit={1.3} shiftY={0.08} />
      </Suspense>
      <div className="pointer-events-none absolute inset-0">
        <div className="container-page h-full">
          <div className="relative h-full">
            <div className="absolute top-8 left-0 hidden w-64 lg:block">
              <p className="micro-label text-ink-3">Sample · 3 floors</p>
              <p className="mt-2 font-display text-display leading-none tracking-display">샘플 주택</p>
              <SpecList
                dense
                className="mt-4 border-ink"
                items={[
                  { label: "층", value: "3", unit: "개" },
                  { label: "크기", value: "16 × 11", unit: "m" },
                  { label: "층고", value: "2.9", unit: "m" },
                  { label: "벽·문·창·계단", value: "따로" },
                ]}
              />
              <a href="#sample" className="pointer-events-auto mt-3 inline-block text-label text-ink-3 underline-offset-4 hover:text-ink hover:underline">샘플 건물 들여다보기 →</a>
            </div>
            {/* 오른쪽 아래: 조작 안내 한 줄 (patterns C형) — 글·버튼은 본문 폭에 맞춘다 */}
            <p className="absolute right-0 bottom-8 hidden text-label text-ink-3 lg:block">끌어서 돌리기 · 층을 눌러 들여다보기</p>
          </div>
        </div>
      </div>

      {/* 아래 가운데: 짧은 이름표 + 하는 일 하나 */}
      <div className="absolute bottom-8 left-1/2 flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-3 px-4 text-center">
        <p className="eyebrow">2D 평면도 → 벽·문·창이 나뉜 3D</p>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onFile(f);
          }}
        />
        {/* 2차 부품 평가: 첫 화면의 주 버튼은 기본 크기 — 모형보다 커 보이지 않게 */}
        <Button loading={busy} onClick={() => input.current?.click()}>평면도 올리기</Button>
        <p className="text-label text-ink-3">
          이미지·DXF를 끌어다 놓아도 돼요 ·{" "}
          <button type="button" onClick={onSample} className="underline underline-offset-4 hover:text-ink">샘플로 해 보기</button>
        </p>
        {error ? <p role="alert" className="text-body-sm text-danger">{error}</p> : null}
      </div>

      {/* 파일을 끌고 들어오면 무대 전체가 받는 자리가 된다 */}
      {over ? (
        <div className="pointer-events-none absolute inset-4 grid place-items-center border border-dashed border-ink bg-bg/70">
          <p className="font-display text-display-sm">놓으면 올라가요</p>
        </div>
      ) : null}
    </section>
  );
}

/** 메뉴: 사용법 */
function HowPage() {
  return (
    <div className="grid gap-12 pt-16 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <p className="eyebrow mb-4">사용법</p>
        <h1 className="text-display tracking-display font-display">세 단계면 돼요</h1>
        <ol className="mt-10 grid gap-8 sm:grid-cols-3">
          {[
            ["올리기", "평면도 이미지나 DXF를 첫 화면에 끌어다 놓아요."],
            ["확인", "벽·문·창이 따로 인식돼요. 확실하지 않은 곳은 노란 점선으로 표시하고 물어봐요. 크기가 추정이면 건물 가로 길이를 넣어 맞춰요."],
            ["받기", "고친 내용을 한 번에 적용해 다시 만든 뒤, 벽마다 블록으로 나뉜 .dxf를 받아 스케치업·캐드에서 열어요."],
          ].map(([t, d], i) => (
            <li key={t} className="border-t border-ink pt-3">
              <span className="text-label tabular-nums text-ink-3">{String(i + 1).padStart(2, "0")}</span>
              <p className="mt-1 text-body font-semibold">{t}</p>
              <p className="mt-1 text-body-sm text-ink-2">{d}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="lg:col-span-5">
        <SpecList
          items={[
            { label: "입력", value: "PNG · JPG · BMP · TIFF · WEBP · DXF", note: `${MAX_UPLOAD_MB}MB까지 · DXF 변환은 준비 중` },
            { label: "인식", value: "벽 · 문 · 창 따로" },
            { label: "크기", value: "도면 치수 → 없으면 외벽 두께로 추정", note: "건물 가로 길이를 넣으면 정확해져요" },
            { label: "결과", value: ".dxf (벽별 블록) · .glb · .json" },
            { label: "화면", value: "PC 기준" },
          ]}
        />
      </div>
    </div>
  );
}

/** 메뉴: 소개 */
function AboutPage() {
  return (
    <div className="grid gap-12 pt-16 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <p className="eyebrow mb-4">소개</p>
        <h1 className="text-display tracking-display font-display">도면 한 장에서 편집할 수 있는 3D 뼈대까지</h1>
        <div className="prose-reading mt-8 space-y-4 text-ink-2">
          <p>설계 초기에는 2D 평면도를 보고 캐드·스케치업에서 선을 따고 벽을 세우는 반복 작업이 필요해요. Auto-BIM은 이 일을 줄이기 위해 평면도에서 벽·문·창을 따로 인식해, 요소마다 편집할 수 있는 3D 모델을 만들어요.</p>
          <p>인식이 확실하지 않은 곳은 임의로 고치지 않아요. 확인이 필요한 요소와 크기 추정 여부를 보여 주고, 사용자가 확인하거나 고친 값으로 다시 만들어요.</p>
        </div>
      </div>
      <div className="lg:col-span-5">
        <SpecList
          items={[
            { label: "과제", value: "AI P-실무프로젝트 (캡스톤)", note: "2026.9 – 2026.12" },
            { label: "팀", value: "2분반 3조" },
            { label: "프론트", value: "강민재 · 임준형" },
            { label: "백엔드", value: "조예준 · 조항민" },
            { label: "인식 모델", value: "CubiCasa5K (비상업 라이선스)" },
          ]}
        />
      </div>
    </div>
  );
}
