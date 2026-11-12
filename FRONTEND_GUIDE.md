# 프론트엔드 안내서 — 코드가 어떻게 돌아가나

Auto-BIM 프론트를 처음 읽는 사람(나 포함)을 위한 설명. 위에서부터 읽으면 된다.

## 1. 한 장 요약

```
[브라우저: 이 저장소]                                   [서버: autobim-be]
 업로드 ───────────── POST /api/jobs (파일) ───────────▶ 작업 생성 → 202 { id, status: "queued" }
 상태 확인(폴링) ──── GET /api/jobs/{id} (0.8~3초마다) ─▶ queued → running → succeeded / failed
 결과 보기 ◀──────── job.plan(벽·문·창 JSON) + files(glb·dxf·json 주소)
 고치기(초안에 쌓기)
 적용 ────────────── POST /api/jobs/{id}/supplement ──▶ 인식은 다시 안 하고 3D·dxf만 다시 → revision +1
 다시 폴링 → 새 결과
 받기 ────────────── GET /api/jobs/{id}/files/dxf ────▶ 벽별 블록 .dxf
```

핵심 단어
- **작업(Job)**: 도면 한 장을 처리하는 단위. ID가 주소(`#job-…`)에 들어가서 새로 고쳐도, 다른 사람에게 보내도 같은 결과가 열린다.
- **Plan**: 서버가 인식한 결과(벽 중심선·두께·높이, 문·창 위치·크기, 확인 필요 목록). 단위 mm, y가 위쪽(CAD 기준).
- **리비전(revision)**: 고쳐서 다시 만들 때마다 1씩 오르는 번호. `result_revision`은 "지금 보이는 결과의 번호". 다시 만드는 중에는 `revision`이 더 크고, 화면은 이전 결과(`result_revision`)를 계속 보여 준다.
- **보충 입력(supplement)**: "이 문 폭은 1000", "이 벽 지워", "건물 가로는 12m" 같은 고칠 내용 묶음.

## 2. 파일 지도 (`frontend/src`)

| 파일 | 하는 일 | 먼저 볼 곳 |
|---|---|---|
| `api.ts` | 서버와 주고받는 **유일한** 곳. 계약 타입, 오류 코드 → 한국어, 호출 함수 | 맨 위 타입들 = 백엔드 `docs/api.md` |
| `useJob.ts` | 작업 상태 따라가기(폴링). 끝나면 멈추고, 오래 걸리면 덜 자주 묻는다 | `poll` 함수 |
| `App.tsx` | 화면 고르기: 작업 없음 → 올리기 / 처리 중 → 진행 표시 / 결과 있음 → 작업 화면 | `Shell`의 `content` 정하는 부분 |
| `Workspace.tsx` | 작업 화면 전체. 무대(3D·평면 전환은 무대 위 왼쪽 위) + 오른쪽 패널(01 실제 크기 · 02 고른 요소 · 03 확인 필요 · 04 바뀔 내용) | 맨 위 주석의 데이터 흐름 |
| `draft.ts` | **고칠 내용(초안)**. 고치기 동작, 서버로 보낼 형태로 바꾸기, 미리보기 Plan, 사람이 읽는 목록 | `toRequest`, `previewPlan` |
| `Inspector.tsx` | 고른 벽·문·창의 값 고치기 패널 | `MmField`(숫자 칸) |
| `PlanView.tsx` | 평면(SVG). 중심선 + 두께 → 사각형, 문·창은 벽을 잘라 표시 | `wallPoly` |
| `Viewer3D.tsx` | 3D(three.js). glb 불러오기, 벽·문·창 누르기, 시점·단면(아래 도구 줄 `StageBar`) | `pick`, `paint` |
| `plan.ts` | Plan 계산 도우미(벽 길이·방향, 문 위치, 범위)와 화면에 쓰는 말 | `openingCenter` |
| `building.ts` | 건물 = 층 여러 개(작업 ID·층고·계단·용도). 주소 `#b=`에 담고 꺼내기, 계단 치수 계산 | `encodeBuilding` |
| `BuildingView.tsx` | 건물 3D 엔진: Plan → 벽(문·창 구멍)·바닥·계단, 세우기 애니메이션, 층 확대, 보이기, 위험 스캔·설명 | 맨 위 주석, `frame` 함수 |
| `BuildingPage.tsx` | 건물 화면: 용도, 위험 목록, 층 목록(층고·순서·위층 올리기), 계단 그리기 창(`Dialog size="xl"`) | `StairEditor` |
| `building.ts`의 `effectiveStairs` | 사용자가 그린 계단이 없으면 인식된 "계단실" 공간에서 계단 후보를 만든다(AI Hub 공간 12종 — 백엔드가 `spaces`를 주면 동작) | |
| `checks.ts` | 객체별 점검 — 벽·문·창을 하나씩 보고 값이 이상한 것 찾기(벽 밖 문, 겹친 창, 안 붙은 벽…). 서버에 묻지 않는다 | `checkPlan` |
| `sheet.ts` · `SheetSplitter.tsx` | 한 장에 평면이 여러 개인 도면: 평면 후보 찾기(잉크 덩어리) → 상자 고치기 → 잘라서 따로 올리기 | `findBlobs` |
| `SitePage.tsx` | 나눈 평면마다 건물 하나. 끌어서 다른 건물 위에 놓으면 층으로 쌓임(주소 `#s=`) | `StackCard`, `building.ts`의 `stackOnto` |
| `scripts/test-units.mjs` | 위 순수 함수들의 테스트(`npm test`, 빌드 때도 돈다) | |
| `rules.ts` | 위험 검토 규칙 — 용도별 기준 수치, 법규/통상 구분, "왜 위험한지" 문장 | `STAIR_STD`, `review` |
| `stageFloor.ts` | 3D 무대 공간감: 흐려지는 바닥 격자, 그림자 바닥, 무대 CSS 변수(--stage-*) 읽기 — Viewer3D가 씀 | `makeFadingGrid` |
| `riskPin.ts` | 위험 번호 모양(3D와 목록이 같이 씀), 정렬(층 → 법규 먼저)·요소별 묶기 — 이 순서가 곧 번호 | `sortFindings`, `groupFindings` |
| `sampleBuilding.ts` | 샘플 3층(첫 화면·`#sample`) — 2층에 일부러 문제를 넣어 둠 | |
| `site-theme.css` | 이 사이트만의 색·글꼴(디자인 플레이북 위에 덮어씀). **도면 색 약속**도 여기. editorial 디렉션 값보다 이 파일이 앞선다(모서리 2px·먹빛 남색) | `--color-door` 등 |

### 화면 틀 — 무대 + 패널 (디자인 플레이북 v0.2.1, patterns C형 도구형 변형)

```
┌ 제목 줄: 작은 라벨 · 파일 이름(제목 글꼴) ─────────── 다른 형식 · [보조] [주 버튼 1개] 다른 도면 ┐
├ 무대 (테두리 없음, 바탕색만) ───────────────────┬ 패널 (위 진한 선 1개, 묶음은 가는 선) ┤
│ [보기 전환 Segmented]                          │ 01 실제 크기                       │
│                                               │ 02 고른 요소                       │
│              3D · 평면 (주인공)                 │ 03 확인 필요            1개 남음   │
│                                               │ 04 바뀔 내용   [적용해서 다시 만들기] │
│ [아래 도구 줄 StageBar: 시점 · 단면 높이]          │ ▸ 모든 벽·문·창                    │
├ 색 설명 · 수치 한 줄(SpecList row) ──────────────┘                                    │
```

| 부품 (`@design`) | 어디에 | 지킬 것 |
|---|---|---|
| `Segmented` | 3D·평면 전환, 시점, 층 고르기 | 칸 2~6개. 무대 위에 뜨면 `floating`. ←/→로 고른다 |
| `StageBar` | 무대 아래 도구 줄(시점·단면, 보이기) | 넓은 화면에선 무대 위에 뜨고, **좁은 화면에선 무대 아래로 내려온다**(375px에서 3D를 덮지 않게). 무대는 `relative` 바깥 틀 안에 [고정 비율 칸] + `StageBar` 형제로 |
| `PanelSection` | 오른쪽 패널의 번호 묶음 | 상자 대신 위 선. 추정·확인이 필요하면 `tone="review"` |
| `SpecList layout="row"` | 무대 아래 수치 한 줄 | 4칸 이하, 숫자는 고정폭 |
| `Checkbox size="sm"` | 도구 줄 안 켜고 끄기(보이기) | 폼(동의 등)은 기본 크기 |
| `Dialog size="xl"` | 계단 그리기처럼 창 안에서 그리는 도구 | 위에 붙는 창. 창 안에서 끌다가 밖에서 놓아도 닫히지 않는다 |

## 3. 꼭 알아야 할 설계 다섯 가지

### ① 화면 상태를 따로 두지 않는다 — 작업 상태가 곧 화면
`App.tsx`는 "지금 몇 단계"를 저장하지 않는다. `job.status`와 `job.result_revision`만 보고 어느 화면인지 정한다.
그래서 새로 고침·주소 공유·뒤로 가기에도 화면이 어긋나지 않는다.

### ② 고친 것은 모았다가 한 번에 보낸다 (초안)
칸 하나 고칠 때마다 서버에 보내면 그때마다 3D·dxf를 다시 만들어 느리고 리비전만 쌓인다.
그래서 `draft`에 모아 두고, "바뀔 내용" 목록에서 하나씩 되돌릴 수 있게 한 뒤, "적용"에서 `toRequest(draft)` 하나로 보낸다.
서버가 받아들이면(202) 초안은 비운다 — 이제 서버 기록에 쌓였기 때문.

### ③ 미리보기와 서버 결과를 구분한다
- **평면·속성 패널** = `previewPlan(plan, draft)` → 고친 내용이 **바로** 보인다(서버에 안 물어봄)
- **3D** = 서버가 만든 glb → **적용해야** 바뀐다
이 차이를 3D 위 안내 문구로 알려 준다.

### ④ 서버 규칙을 화면이 미리 지킨다
백엔드는 "지운 요소를 다시 참조하면 400"을 낸다. 그래서 `removeElement`가 지울 때 그 요소(와 벽에 붙은 문·창)에 걸린 다른 고칠 내용을 같이 버린다.
"벽을 지우면 붙은 문·창도 함께 지워진다"는 규칙도 미리 보여 준다("붙은 o5 함께").

### ⑤ 좌표 바꾸기는 한 줄 규칙
- Plan: mm, x 오른쪽 **y 위쪽** (CAD)
- SVG(평면): y가 아래쪽이라 도면 묶음을 `scale(1,-1)`로 뒤집어 그림
- 3D(glTF): m, **Y가 위**. Plan `(x, y)` → 3D `(x/1000, 높이, −y/1000)`
문·창은 glb 안에서 벽 구멍일 뿐이라, Plan 값으로 상자를 만들어 같은 자리에 놓고 누를 수 있게 했다(`Viewer3D.tsx`).

## 4. 자주 할 일

| 하고 싶은 것 | 고칠 곳 |
|---|---|
| 백엔드가 응답에 칸을 추가/변경 | `api.ts` 타입 → 타입 오류 나는 곳을 따라가며 고침 (`npx tsc --noEmit`) |
| 오류 문구 바꾸기 | `api.ts`의 `ERROR_TEXT` |
| 확인 필요 이유 문구 | `plan.ts`의 `REASON_LABEL` |
| 도면 색 바꾸기 | `site-theme.css`의 `--color-wall`·`--color-door`… (2D·3D·범례가 같이 바뀜) |
| 새 고치기 동작(예: 벽 추가) | `draft.ts`에 상태·동작·`toRequest`·`changeList` → `Inspector`/`PlanView`에 버튼 |
| 디자인 규칙 확인 | `design/DESIGN.md` — 끝나면 Claude Code에 "design-review 해줘". 캡처·접근성은 `node scripts/shoot.mjs <주소>`, 규칙 검사는 `node scripts/design-lint.mjs frontend/src` |
| 무대 위에 도구 추가 | 위 왼쪽은 보기 전환 하나(`Segmented floating`), 나머지는 아래 `StageBar` 안에. 무대 위 도구는 두 묶음까지 |

## 5. 직접 해 보기 (연습 과제)

쉬운 것부터.
1. `api.ts`의 `ERROR_TEXT`에서 `job_busy` 문구를 바꾸고, 적용 버튼을 두 번 빨리 눌러 문구를 확인해 보기
2. `site-theme.css`에서 `--color-window`를 바꾸고 2D·3D·범례가 같이 바뀌는지 보기
3. `Workspace.tsx`의 SpecList에 "외벽 수"를 한 줄 추가해 보기 (`plan.walls.filter(w => w.kind === "exterior").length`)
4. (어려움) 평면에서 두 점을 눌러 벽을 추가하기: `draft.ts`에 `addWalls`를 만들고 `toRequest`에서 `add_walls`로 보내기. `PlanView`에서 클릭 좌표를 SVG → Plan 좌표로 바꾸는 게 핵심(y 뒤집기 주의)

막히면 Claude Code에 파일 이름과 함께 물어보면 된다. 예: "draft.ts에 벽 추가 기능을 넣고 싶어. 방법만 설명해 줘, 코드는 내가 쓸게."
