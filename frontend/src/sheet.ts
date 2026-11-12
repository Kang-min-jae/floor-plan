// 도면 한 장 나누기 — 한 장에 평면이 여러 개 그려져 있으면(최대 4개) 평면마다 잘라 따로 올린다.
//
// 왜 프론트에서 하나: 백엔드는 한 장에서 가장 큰 평면 하나만 변환하고 "평면이 여러 개"라고 알려 주기만 한다
// (autobim-be app/recognition/topology.py). 원본 이미지는 올리는 순간 브라우저에 있으므로 여기서 자른다.
//
// 자동 찾기는 "어림"이다: 잉크(바탕과 다른 색)를 조금 부풀려 서로 붙은 덩어리를 찾고, 큰 덩어리를 평면 후보로 본다.
// 범례·표제란이 섞일 수 있어 사용자가 상자를 지우고 다시 그릴 수 있다(SheetSplitter). 서버로는 자른 그림만 간다.
// 판단 규칙을 바꾸면 scripts/test-units.mjs의 덩어리 찾기 테스트도 함께 고친다.

/** 원본 이미지 픽셀 기준 사각형 */
export type Region = { x: number; y: number; w: number; h: number };

export const REGION_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** 잉크 격자(1 = 잉크)에서 평면 후보 덩어리를 찾는다. 순수 함수 — 테스트하기 쉽게 그림 읽기와 나눴다. */
export function findBlobs(ink: Uint8Array, W: number, H: number, max: number): Region[] {
  // 부풀리기(가로 → 세로 창): 벽 선·치수선이 끊겨 있어도 한 평면이 한 덩어리가 되게
  const r = Math.max(2, Math.round(Math.max(W, H) * 0.018));
  const grow = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(W * H);
    const n = horizontal ? W : H, m = horizontal ? H : W;
    for (let j = 0; j < m; j++) {
      let last = -1e9;
      const at = (i: number) => (horizontal ? j * W + i : i * W + j);
      for (let i = 0; i < n; i++) { if (src[at(i)]) last = i; if (i - last <= r) out[at(i)] = 1; }
      last = 1e9;
      for (let i = n - 1; i >= 0; i--) { if (src[at(i)]) last = i; if (last - i <= r) out[at(i)] = 1; }
    }
    return out;
  };
  const fat = grow(grow(ink, true), false);

  // 붙은 덩어리 찾기
  const label = new Int32Array(W * H);
  const blobs: { x0: number; y0: number; x1: number; y1: number; ink: number; core: number }[] = [];
  const cx0 = W * 0.12, cx1 = W * 0.88, cy0 = H * 0.12, cy1 = H * 0.88; // 종이 가장자리 띠를 뺀 안쪽
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!fat[s] || label[s]) continue;
    const id = blobs.length + 1;
    const b = { x0: W, y0: H, x1: 0, y1: 0, ink: 0, core: 0 };
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % W, y = (q - x) / W;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      if (ink[q]) { b.ink++; if (x > cx0 && x < cx1 && y > cy0 && y < cy1) b.core++; }
      if (x > 0 && fat[q - 1] && !label[q - 1]) { label[q - 1] = id; stack.push(q - 1); }
      if (x < W - 1 && fat[q + 1] && !label[q + 1]) { label[q + 1] = id; stack.push(q + 1); }
      if (y > 0 && fat[q - W] && !label[q - W]) { label[q - W] = id; stack.push(q - W); }
      if (y < H - 1 && fat[q + W] && !label[q + W]) { label[q + W] = id; stack.push(q + W); }
    }
    blobs.push(b);
  }

  // 평면 후보: 가로·세로 모두 어느 정도 크고(글자 줄·선 하나가 아님), 가장 큰 덩어리의 1/8 이상
  const sized = blobs
    .map((b) => ({ ...b, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    // 도면 테두리(종이 전체를 감싼 틀, 거기 붙은 표제란)는 뺀다: 종이 거의 전체를 덮는데 잉크는 가장자리 띠에 몰려 있다
    .filter((b) => !(b.w > W * 0.92 && b.h > H * 0.92 && b.core < b.ink * 0.35))
    .filter((b) => b.w >= W * 0.1 && b.h >= H * 0.1);
  const top = Math.max(0, ...sized.map((b) => b.ink));
  return sized
    .filter((b) => b.ink >= top / 8)
    .sort((a, b) => b.ink - a.ink)
    .slice(0, max)
    // 읽는 순서(위 → 아래, 왼쪽 → 오른쪽)로 이름 A·B·C·D를 붙인다
    .sort((a, b) => (Math.abs(a.y0 - b.y0) > H * 0.15 ? a.y0 - b.y0 : a.x0 - b.x0))
    .map((b) => ({ x: Math.max(0, b.x0 - r), y: Math.max(0, b.y0 - r), w: Math.min(W, b.x1 + r + 1) - Math.max(0, b.x0 - r), h: Math.min(H, b.y1 + r + 1) - Math.max(0, b.y0 - r) }));
}

/** 올린 그림을 읽는다. 브라우저가 못 읽는 형식(TIFF 등)이면 null — 그때는 나누기 없이 그대로 올린다 */
export async function readImage(file: File): Promise<ImageBitmap | null> {
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) return null;
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

/** 그림에서 평면 후보를 찾는다(원본 픽셀 좌표). 하나뿐이거나 못 찾으면 나눌 필요가 없다 */
export function detectRegions(img: ImageBitmap, max: number): Region[] {
  const k = Math.min(1, 320 / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.fillStyle = "white"; // 투명 PNG는 흰 종이로 본다
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  // 밝기 — 가장 흔한 밝기를 바탕으로 보고, 거기서 많이 벗어난 것을 잉크로 (어두운 바탕 도면도 되게)
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(16);
  for (let i = 0; i < W * H; i++) {
    lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    hist[lum[i] >> 4]++;
  }
  const bg = hist.indexOf(Math.max(...hist)) * 16 + 8;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = Math.abs(lum[i] - bg) > 56 ? 1 : 0;
  return findBlobs(ink, W, H, max).map((b) => ({ x: Math.round(b.x / k), y: Math.round(b.y / k), w: Math.round(b.w / k), h: Math.round(b.h / k) }));
}

/** 사각형만큼 잘라 PNG 파일로 만든다(원본 해상도 그대로 — 축척이 평면마다 달라지지 않게) */
export async function cropToFile(img: ImageBitmap, r: Region, name: string): Promise<File> {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(r.w));
  cv.height = Math.max(1, Math.round(r.h));
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
  const blob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/png"));
  if (!blob) throw new Error("crop_failed");
  return new File([blob], name, { type: "image/png" });
}

/** 잘라 올릴 파일 이름: 원래 이름-A.png */
export const partName = (file: File, i: number) => `${file.name.replace(/\.[^.]+$/, "") || "plan"}-${REGION_NAMES[i] ?? i + 1}.png`;
