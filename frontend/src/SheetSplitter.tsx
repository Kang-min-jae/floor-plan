// 도면 나누기 창 — 한 장에 평면이 여러 개면 평면마다 상자를 쳐서 따로 올린다(최대 4개).
//
// 자동으로 찾은 상자를 먼저 보여 주고, 사용자가 지우거나(범례·표제란이 잡혔을 때) 끌어서 새로 그린다.
// 자르기는 브라우저에서 하고(sheet.ts), 서버로는 자른 그림만 간다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, cx } from "@design";
import { MAX_PLANS } from "./building";
import { REGION_NAMES, cropToFile, detectRegions, partName, readImage, type Region } from "./sheet";

type Props = {
  file: File | null; // 열려 있으면 이 그림을 나눈다
  suggested?: Region[] | null; // 올릴 때 이미 찾아 둔 상자(없으면 여기서 찾는다)
  busy?: boolean; // 나눠 올리는 중
  error?: string;
  progress?: string; // "2 / 3 올리는 중"
  onSplit: (parts: File[]) => void;
  onWhole?: () => void; // 나누지 않고 그대로 올리기(올리기 전에 물어볼 때만)
  onClose: () => void;
};

export function SheetSplitter({ file, suggested, busy, error, progress, onSplit, onWhole, onClose }: Props) {
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<Region | null>(null);
  const [failed, setFailed] = useState(false);
  const [cutting, setCutting] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  useEffect(() => {
    let stop = false;
    setImg(null); setRegions([]); setSel(null); setFailed(false);
    if (!file) return;
    readImage(file).then((bmp) => {
      if (stop) return bmp?.close();
      if (!bmp) return setFailed(true);
      setImg(bmp);
      setRegions(suggested?.length ? suggested : detectRegions(bmp, MAX_PLANS));
    });
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // 화면 좌표 → 그림 픽셀 좌표
  const toImg = (e: React.PointerEvent) => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: Math.min(img!.width, Math.max(0, p.x)), y: Math.min(img!.height, Math.max(0, p.y)) };
  };
  const full = regions.length >= MAX_PLANS;
  const norm = (r: Region): Region => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });
  const stroke = img ? Math.max(img.width, img.height) / 400 : 1;

  const split = async () => {
    if (!img || !file) return;
    setCutting(true);
    try {
      onSplit(await Promise.all(regions.map((r, i) => cropToFile(img, r, partName(file, i)))));
    } finally {
      setCutting(false);
    }
  };

  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      size="xl"
      dismissible={!busy}
      title="도면 나누기"
      description={`평면마다 상자를 쳐 주세요(최대 ${MAX_PLANS}개). 상자 하나가 건물 하나로 세워져요. 같은 건물의 다른 층이면 올린 뒤에 끌어서 쌓을 수 있어요.`}
      actions={
        <>
          {onWhole ? <Button variant="text" onClick={onWhole} disabled={busy}>나누지 않고 그대로 올리기</Button> : <Button variant="text" onClick={onClose} disabled={busy}>닫기</Button>}
          <Button onClick={split} loading={busy || cutting} disabledReason={!regions.length ? "상자를 하나 이상 그려 주세요" : undefined}>
            {busy && progress ? progress : `${regions.length}개로 나눠 올리기`}
          </Button>
        </>
      }
    >
      {failed ? (
        <p className="py-10 text-center text-body-sm text-ink-2">이 형식은 브라우저에서 열 수 없어 나눌 수 없어요. PNG·JPG·WEBP·BMP로 바꿔 올리거나, 평면마다 따로 잘라 올려 주세요.</p>
      ) : !img || !url ? (
        <p className="py-10 text-center text-body-sm text-ink-3">도면을 읽는 중…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="bg-bg p-2 lg:col-span-8">
            <svg
              ref={svg}
              viewBox={`0 0 ${img.width} ${img.height}`}
              className={cx("block max-h-144 w-full touch-none select-none", !full && "cursor-crosshair")}
              role="img"
              aria-label={`도면 — 평면 상자 ${regions.length}개. 끌어서 상자를 새로 그려요`}
              onPointerDown={(e) => {
                if (full || busy) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                const p = toImg(e);
                setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
                setSel(null);
              }}
              onPointerMove={(e) => { if (drag) { const p = toImg(e); setDrag({ ...drag, w: p.x - drag.x, h: p.y - drag.y }); } }}
              onPointerUp={() => {
                if (!drag) return;
                const r = norm(drag);
                setDrag(null);
                // 너무 작은 상자는 실수로 누른 것
                if (r.w > img.width * 0.05 && r.h > img.height * 0.05) { setRegions([...regions, r]); setSel(regions.length); }
              }}
            >
              <image href={url} width={img.width} height={img.height} />
              {regions.map((r, i) => (
                <g key={i} onPointerDown={(e) => { e.stopPropagation(); setSel(i); }} className="cursor-pointer">
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={stroke * (sel === i ? 2 : 1.2)} className={cx("fill-accent/10 stroke-accent", sel === i && "fill-accent/20")} />
                  <rect x={r.x} y={r.y} width={stroke * 14} height={stroke * 14} className="fill-accent" />
                  <text x={r.x + stroke * 7} y={r.y + stroke * 10.5} textAnchor="middle" fontSize={stroke * 10} className="fill-bg font-semibold">{REGION_NAMES[i]}</text>
                </g>
              ))}
              {drag ? <rect {...(({ x, y, w, h }) => ({ x, y, width: w, height: h }))(norm(drag))} strokeWidth={stroke * 1.2} strokeDasharray={`${stroke * 4} ${stroke * 3}`} className="fill-accent/10 stroke-accent" /> : null}
            </svg>
          </div>
          <div className="space-y-4 lg:col-span-4">
            <p className="text-body-sm text-ink-2">
              {regions.length ? `평면 ${regions.length}개를 찾았어요. 범례·표제란이 잡혔으면 지우고, 빠진 평면은 도면 위에서 끌어 상자를 그려 주세요.` : "평면을 자동으로 찾지 못했어요. 도면 위에서 끌어 평면마다 상자를 그려 주세요."}
            </p>
            <ul className="divide-y divide-line border-y border-line">
              {regions.map((r, i) => (
                <li key={i} className={cx("flex items-center justify-between gap-3 py-2.5", sel === i && "bg-surface-2")}>
                  <button type="button" onClick={() => setSel(i)} aria-pressed={sel === i} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                    <span className="font-display text-title tracking-title">평면 {REGION_NAMES[i]}</span>
                    <span className="text-label tabular-nums text-ink-3">{Math.round(r.w)} × {Math.round(r.h)} px</span>
                  </button>
                  <button type="button" disabled={busy} onClick={() => { setRegions(regions.filter((_, k) => k !== i)); setSel(null); }} className="shrink-0 text-label text-danger underline-offset-4 hover:underline" aria-label={`평면 ${REGION_NAMES[i]} 상자 지우기`}>
                    지우기
                  </button>
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setRegions(detectRegions(img, MAX_PLANS)); setSel(null); }}>자동으로 다시 찾기</Button>
            {full ? <p className="text-label text-ink-3">한 번에 {MAX_PLANS}개까지 나눌 수 있어요. 더 그리려면 상자를 하나 지워 주세요.</p> : null}
            {error ? <p role="alert" className="text-body-sm text-danger">{error}</p> : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
