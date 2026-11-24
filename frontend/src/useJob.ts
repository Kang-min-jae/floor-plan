// 작업 상태 따라가기(폴링) — 변환은 서버에서 따로 돌기 때문에, 끝날 때까지 주기적으로 물어본다.
//
//   queued ─▶ running ─▶ succeeded
//                    └─▶ failed
// 보충 입력을 보내면 다시 queued가 되고 revision이 1 오른다. 그동안에도 job.plan·files는
// "마지막 성공 결과"(result_revision)를 그대로 갖고 있어서, 화면은 이전 결과를 계속 보여줄 수 있다.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getJob, type Job } from "./api";

const busy = (j: Job | null) => j?.status === "queued" || j?.status === "running";

/** 잠깐 끊긴 것(연결 끊김·서버 5xx·요청 많음)이면 다시 묻는다. 작업이 없으면(404) 멈춘다 */
export const retryable = (e: ApiError) => e.code === "network" || e.status >= 500 || e.status === 408 || e.status === 429;

export function useJob(id: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const tries = useRef(0);
  // 세대 번호: 다른 작업으로 넘어가거나 track()으로 새 응답을 받으면 1 올린다.
  // 그 전에 보낸 요청의 응답이 늦게 와도(세대가 다르면) 버린다 — 다른 작업·옛 상태가 화면을 덮지 않게
  const gen = useRef(0);

  const stop = () => window.clearTimeout(timer.current);

  const poll = useCallback(async (jobId: string, g: number) => {
    if (g !== gen.current) return;
    stop();
    try {
      const j = await getJob(jobId);
      if (g !== gen.current) return;
      setJob(j);
      setError(null);
      if (busy(j)) {
        // 처음엔 자주(0.8초), 오래 걸리면 덜 자주(최대 3초) — 서버 부담 줄이기
        tries.current += 1;
        timer.current = window.setTimeout(() => poll(jobId, g), Math.min(3000, 800 + tries.current * 100));
      } else {
        tries.current = 0;
      }
    } catch (e) {
      if (g !== gen.current) return;
      const err = e instanceof ApiError ? e : new ApiError("network", "서버에 연결하지 못했어요.");
      setError(err);
      if (retryable(err)) timer.current = window.setTimeout(() => poll(jobId, g), 3000);
    }
  }, []);

  useEffect(() => {
    const g = ++gen.current;
    setJob(null);
    setError(null);
    tries.current = 0;
    if (id) poll(id, g);
    return () => {
      gen.current++;
      stop();
    };
  }, [id, poll]);

  /** 업로드·보충 입력의 202 응답을 바로 반영하고 다시 따라가기 시작 */
  const track = useCallback(
    (j: Job) => {
      const g = ++gen.current; // 이 전에 보낸 요청의 응답은 버린다
      stop();
      setJob(j);
      tries.current = 0;
      if (busy(j)) timer.current = window.setTimeout(() => poll(j.id, g), 600);
    },
    [poll],
  );

  return { job, error, busy: busy(job), track, refresh: () => id && poll(id, gen.current) };
}
