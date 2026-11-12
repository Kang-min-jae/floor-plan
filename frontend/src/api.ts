// 백엔드(Auto-BIM/autobim-be) API — 서버와 주고받는 일은 모두 이 파일 하나를 거친다.
//
// 약속서(계약): autobim-be의 docs/api.md · docs/openapi.json
// 아래 타입은 그 약속서를 그대로 옮긴 것이다. 백엔드가 계약을 바꾸면 여기부터 고친다.
// (풀스택 플레이북 5장 "외부 시스템마다 모듈 하나" — 화면 코드는 fetch를 직접 부르지 않는다)

/** 개발 중에는 비워 둔다(Vite가 /api를 백엔드로 넘겨 줌). 배포하면 VITE_API_BASE=https://백엔드주소 */
export const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

// ─── 계약 타입 ────────────────────────────────────────────────────────────
// 길이는 모두 mm. 좌표는 CAD 축(x 오른쪽, y 위쪽).

export type Point = { x: number; y: number };
export type WallKind = "exterior" | "interior" | "unknown";
export type OpeningType = "door" | "window";

export type Wall = {
  id: string; // w1, w2, …
  start: Point; // 중심선 시작점
  end: Point; // 중심선 끝점
  thickness: number;
  height: number;
  kind: WallKind;
  confidence: number | null; // 사용자가 추가한 벽은 null
};

export type Opening = {
  id: string; // o1, o2, …
  type: OpeningType;
  wall_id: string; // 이 문·창이 뚫린 벽
  position: number; // 벽 시작점 → 개구부 "중심"까지 거리
  width: number;
  height: number;
  sill_height: number; // 바닥 → 개구부 아래. 문은 0
  confidence: number | null;
};

export type ReviewReason =
  | "low_confidence"
  | "scale_estimated"
  | "default_value_applied"
  | "unattached_opening"
  | "dimension_conflict"
  | "other";

export type ReviewItem = {
  element_id: string; // 벽·개구부 ID, 도면 전체 문제면 "plan"
  element_kind: "wall" | "opening" | "dimension" | "plan";
  reason: ReviewReason;
  message: string; // 백엔드가 쓴 설명(영어일 수 있음)
  confidence: number;
};

export type Scale = {
  source: "dimension" | "building_width" | "assumed_wall_thickness" | "user" | "source_units";
  estimated: boolean; // 측정이 아니라 추정이면 true
  mm_per_px: number | null;
};

/** 공간(실) — ⚠ 아직 계약에 없음. 프론트가 제안하는 모양(README "백엔드 팀에 전할 것").
 *  AI Hub 건축 도면 데이터의 "공간" 12종을 그대로 쓴다. 백엔드가 넣어 주면 화면이 자동으로 쓰고, 없으면 무시한다. */
export type SpaceType =
  | "living" | "bedroom" | "kitchen" | "entrance" | "balcony" | "bathroom"
  | "outdoor_unit" | "dressroom" | "multipurpose" | "elevator_hall" | "stair" | "elevator";
export type Space = {
  id: string; // r1, r2…
  type: SpaceType;
  polygon: Point[]; // 바깥 경계(mm, CAD 축)
  confidence: number | null;
};

export type Plan = {
  schema_version: string;
  units: "mm";
  source: { type: "image" | "dxf"; filename: string | null; width_px: number | null; height_px: number | null };
  scale: Scale;
  walls: Wall[];
  openings: Opening[];
  review_items: ReviewItem[];
  spaces?: Space[]; // 제안(계약 밖) — 있으면 실 이름·계단실 자동 계단에 쓴다
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type Job = {
  id: string;
  status: JobStatus;
  revision: number; // 요청된 최신 리비전 (보충 입력마다 +1)
  result_revision: number | null; // 지금 plan·files가 속한 마지막 "성공" 리비전
  created_at: string;
  updated_at: string;
  input: { filename: string; type: "image" | "dxf"; content_type: string | null };
  plan: Plan | null;
  error: { code: string; message: string } | null;
  files: Partial<Record<FileKind, string>>; // 결과가 없으면 {}
  removed: { id: string; element_kind: "wall" | "opening"; revision: number; cascade_from: string | null }[];
};

export type FileKind = "dxf" | "glb" | "json";

/** 보충 입력 — 모든 칸이 선택. 모델을 다시 돌리지 않고 Plan만 고쳐 다시 만든다. */
export type ScaleHint =
  | { mm_per_px: number }
  | { building_width_mm: number }
  | { reference: { wall_id: string; length_mm: number } };
export type WallPatch = { id: string; thickness?: number; height?: number; kind?: WallKind };
export type OpeningPatch = {
  id: string;
  type?: OpeningType;
  wall_id?: string;
  position?: number;
  width?: number;
  height?: number;
  sill_height?: number;
};
export type NewOpening = { type: OpeningType; wall_id: string; position: number; width?: number; height?: number; sill_height?: number };
export type NewWall = { start: Point; end: Point; kind?: WallKind; thickness?: number; height?: number };

export type SupplementRequest = {
  scale?: ScaleHint;
  walls?: WallPatch[];
  openings?: OpeningPatch[];
  remove?: string[];
  add_walls?: NewWall[];
  add_openings?: NewOpening[];
  resolved?: string[];
};

// ─── 오류 ────────────────────────────────────────────────────────────────

/** 화면에 보여줄 한국어 메시지와 원래 코드를 함께 담는다 */
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
  }
}

// 백엔드 오류 코드 → 사용자에게 보여줄 말 (docs/api.md "오류 형식" 표)
const ERROR_TEXT: Record<string, string> = {
  network: "서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  job_not_found: "작업을 찾을 수 없어요. 주소를 확인하거나 도면을 다시 올려 주세요.",
  job_busy: "아직 다시 만드는 중이에요. 끝난 뒤에 적용해 주세요.",
  no_plan: "인식 결과가 없어서 고칠 수 없어요. 다른 도면으로 다시 올려 주세요.",
  not_ready: "아직 결과 파일이 없어요.",
  unsupported_media_type: "평면도 이미지(PNG·JPG·BMP·TIFF·WEBP)나 DXF만 올릴 수 있어요.",
  file_too_large: "파일이 너무 커요. 더 작은 파일로 올려 주세요.",
  image_too_large: "그림이 너무 커요(가로 × 세로 픽셀 수). 해상도를 낮춰 올려 주세요.",
  unknown_element: "이미 지워졌거나 없는 요소예요. 화면을 새로 고친 뒤 다시 해 주세요.",
  invalid_supplement: "적용할 수 없는 값이에요. 숫자를 확인해 주세요.",
  // Job.error.code — 작업이 실패한 이유
  not_implemented: "DXF 변환은 아직 준비 중이에요. 지금은 평면도 이미지를 올려 주세요.",
  no_walls: "도면에서 벽을 찾지 못했어요. 더 선명한 평면도로 다시 올려 주세요.",
  scale_unresolvable: "도면의 실제 크기를 정하지 못했어요. 건물 가로 길이를 넣어 주세요.",
  internal_error: "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.",
};
export const errorText = (code: string, fallback?: string) => ERROR_TEXT[code] ?? fallback ?? "요청을 처리하지 못했어요.";

async function call<T>(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError("network", errorText("network"));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 앱 오류: { detail: { code, message } } / 형식 오류(422): { detail: [ … ] }
    const d = body?.detail;
    const code = typeof d?.code === "string" ? d.code : res.status === 422 ? "invalid_supplement" : String(res.status);
    throw new ApiError(code, errorText(code, typeof d?.message === "string" ? d.message : undefined), res.status);
  }
  return body as T;
}

// ─── 호출 ────────────────────────────────────────────────────────────────

/** 업로드 → 작업 생성 (202). 변환은 서버가 따로 진행하므로 getJob으로 상태를 확인한다. */
export function createJob(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return call<Job>("/api/jobs", { method: "POST", body: fd }, 120_000);
}

export const getJob = (id: string) => call<Job>(`/api/jobs/${encodeURIComponent(id)}`);

/** 보충 입력 → 다시 만들기 (202, revision +1) */
export const supplement = (id: string, req: SupplementRequest) =>
  call<Job>(`/api/jobs/${encodeURIComponent(id)}/supplement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

/** 결과 파일 주소. 같은 주소라도 리비전이 바뀌면 내용이 바뀌므로 ?r=로 캐시를 나눈다 */
export const fileUrl = (job: Job, kind: FileKind) => {
  const p = job.files[kind];
  return p ? `${API}${p}?r=${job.result_revision ?? 0}` : null;
};

/** 내려받을 때 쓸 파일 이름: 원래 이름 + 리비전 */
export const downloadName = (job: Job, kind: FileKind) =>
  `${job.input.filename.replace(/\.[^.]+$/, "") || "plan"}-r${job.result_revision ?? 0}.${kind}`;

// 업로드 전에 브라우저에서 먼저 거르는 형식 (최종 판단은 서버)
export const ACCEPT = ".png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp,.dxf";
export const MAX_UPLOAD_MB = 30; // 백엔드 limits.max_upload_mb 기본값과 같게(docs/api.md "업로드 제한", 413 file_too_large). 픽셀 수 상한(4천만)은 서버가 본다
