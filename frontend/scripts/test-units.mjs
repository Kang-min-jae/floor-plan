// 순수 함수 테스트 — 객체별 점검(checks.ts), 도면 덩어리 찾기(sheet.ts), 건물 쌓기(building.ts).
// 실행: npm test  (esbuild로 TS를 묶어 node --test로 돌린다. esbuild는 vite가 함께 설치한다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "autobim-test-"));
const entry = join(dir, "entry.ts");
const src = new URL("../src/", import.meta.url).pathname;
writeFileSync(entry, `export * from "${src}checks"; export { findBlobs } from "${src}sheet"; export { stackOnto, unstack, siteLabels, decodeSite, siteHash } from "${src}building";`);
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: join(dir, "out.mjs"), logLevel: "silent" });
const { checkPlan, hasOtherPlans, findBlobs, stackOnto, unstack, siteLabels, decodeSite, siteHash } = await import(pathToFileURL(join(dir, "out.mjs")).href);

// 8m × 5m 방 하나: 외벽 4개 + 문 1개 + 창 1개
const wall = (id, x0, y0, x1, y1, o = {}) => ({ id, start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 200, height: 2400, kind: "exterior", confidence: 0.9, ...o });
const opening = (id, wall_id, position, o = {}) => ({ id, type: "door", wall_id, position, width: 900, height: 2100, sill_height: 0, confidence: 0.9, ...o });
const room = (extra = {}) => ({
  schema_version: "1.0", units: "mm", source: { type: "image", filename: "t.png", width_px: 1, height_px: 1 }, scale: { source: "user", estimated: false, mm_per_px: 10 },
  walls: [wall("w1", 0, 0, 8000, 0), wall("w2", 8000, 0, 8000, 5000), wall("w3", 8000, 5000, 0, 5000), wall("w4", 0, 5000, 0, 0)],
  openings: [opening("o1", "w1", 2000), opening("o2", "w3", 4000, { type: "window", width: 1200, height: 1200, sill_height: 900 })],
  review_items: [], ...extra,
});
const codes = (plan) => checkPlan(plan).map((c) => `${c.id}:${c.code}`).sort();

test("멀쩡한 방은 아무것도 걸리지 않는다", () => assert.deepEqual(codes(room()), []));

test("문·창: 벽 밖, 겹침, 벽보다 높음, 붙은 벽 없음", () => {
  const p = room();
  p.openings.push(opening("o3", "w1", 7900)); // 8000 벽에서 7450~8350 → 밖
  p.openings.push(opening("o4", "w1", 2300)); // o1(1550~2450)과 겹침
  p.openings.push(opening("o5", "w2", 2500, { type: "window", height: 2000, sill_height: 900 })); // 2900 > 2400
  p.openings.push(opening("o6", "w9", 100));
  const c = codes(p);
  for (const want of ["o3:opening_outside", "o1:opening_overlap", "o4:opening_overlap", "o5:opening_too_tall", "o6:opening_no_wall"]) assert.ok(c.includes(want), want);
  assert.ok(!c.includes("o2:opening_outside"));
});

test("벽: 너무 짧음, 떨어짐, 외벽 안 닫힘, 겹침, 두께", () => {
  const p = room();
  p.walls.push(wall("w5", 3000, 2000, 3050, 2000, { kind: "interior", thickness: 120 })); // 50mm
  p.walls.push(wall("w6", 3000, 1500, 5000, 1500, { kind: "interior", thickness: 120 })); // 방 한가운데 떠 있음
  p.walls.push(wall("w7", 0, 0, 5000, 0)); // w1과 겹침
  p.walls[1] = wall("w2", 8000, 0, 8000, 3000); // 외벽이 w3에 닿지 않음
  p.walls.push(wall("w8", 4000, 0, 4000, 5000, { kind: "interior", thickness: 900 }));
  const c = codes(p);
  for (const want of ["w5:wall_too_short", "w6:wall_detached", "w7:wall_duplicate", "w2:exterior_open", "w3:exterior_open", "w8:wall_thickness"]) assert.ok(c.includes(want), `${want} in ${c}`);
  assert.ok(!c.some((x) => x.startsWith("w8:wall_detached")), "양 끝이 외벽에 닿은 내벽은 떨어진 벽이 아니다");
});

test("T자로 닿은 내벽은 정상(끝이 외벽 면에서 멈춤)", () => {
  const p = room();
  p.walls.push(wall("w5", 4000, 100, 4000, 4900, { kind: "interior", thickness: 120 })); // 외벽 중심선에서 100 떨어져 끝남
  assert.deepEqual(codes(p), []);
});

test("도면 전체: 외벽 없음 · 문 없음, 평면 여러 개 알림", () => {
  const p = room({ openings: [] });
  p.walls = p.walls.map((w) => ({ ...w, kind: "interior" }));
  assert.deepEqual(codes(p), ["plan:no_door", "plan:no_exterior"]);
  assert.equal(hasOtherPlans(room()), false);
  assert.equal(hasOtherPlans(room({ review_items: [{ element_id: "plan", element_kind: "plan", reason: "other", message: "도면에 평면이 여러 개로 보여 가장 큰 평면만 변환했습니다", confidence: 0.5 }] })), true);
});

test("도면 덩어리 찾기: 평면 3개 + 테두리 + 작은 글자 → 평면 3개만, 읽는 순서", () => {
  const W = 200, H = 160, ink = new Uint8Array(W * H);
  const box = (x0, y0, x1, y1) => { for (let x = x0; x <= x1; x++) { ink[y0 * W + x] = ink[y1 * W + x] = 1; } for (let y = y0; y <= y1; y++) { ink[y * W + x0] = ink[y * W + x1] = 1; } };
  const plan = (x0, y0, x1, y1) => { box(x0, y0, x1, y1); box(x0 + 1, y0 + 1, x1 - 1, y1 - 1); const mx = (x0 + x1) >> 1; for (let y = y0; y <= y1; y++) ink[y * W + mx] = 1; };
  box(1, 1, W - 2, H - 2); // 종이 테두리
  plan(110, 15, 185, 65); plan(15, 15, 90, 65); plan(15, 90, 80, 140);
  for (let x = 150; x < 170; x++) ink[120 * W + x] = 1; // 글자 한 줄
  const r = findBlobs(ink, W, H, 4);
  assert.equal(r.length, 3);
  assert.ok(r[0].x < r[1].x && r[0].y < 40 && r[1].y < 40 && r[2].y > 70, JSON.stringify(r));
  assert.equal(findBlobs(ink, W, H, 2).length, 2);
});

test("건물 쌓기·떼기: 층 이름과 건물 이름표", () => {
  const f = (c) => ({ jobId: c.repeat(32), name: "1F", heightMm: 2900, stairs: [] });
  const site = { use: "apartment", stacks: [[f("a")], [f("b")], [f("c")]] };
  const s1 = stackOnto(site, 2, 0); // C를 A 위에
  assert.deepEqual(s1.stacks.map((st) => st.map((x) => x.jobId[0] + x.name)), [["a1F", "c2F"], ["b1F"]]);
  assert.deepEqual(siteLabels(s1), ["A", "B"]);
  const s2 = unstack(s1, 0, 0); // 1층(a)을 떼면 c가 1층이 되고, a는 새 건물 C
  assert.deepEqual(s2.stacks.map((st) => st.map((x) => x.jobId[0] + x.name)), [["c1F"], ["b1F"], ["a1F"]]);
  assert.deepEqual(siteLabels(s2), ["A", "B", "C"]);
  assert.equal(stackOnto(site, 1, 1), site);
  assert.equal(unstack(site, 0, 0), site, "한 층짜리는 뗄 수 없다");
  globalThis.btoa ??= (s) => Buffer.from(s, "binary").toString("base64");
  const back = decodeSite(siteHash(s2).slice(3));
  assert.deepEqual(back.stacks, s2.stacks);
  assert.equal(decodeSite("bm90LWpzb24"), null);
});
