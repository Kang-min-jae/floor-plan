// 3D 무대의 "공간감" — 바탕색보다 깊이가 공간처럼 보이게 한다 (2026-10-30 "진짜 가상공간에 있는 것 같은" 요청)
//   ① 바탕: CSS 그러데이션(.stage-backdrop — 위가 밝고 바닥 쪽이 약간 어둡다). 3D 캔버스는 투명하게 그려 바탕이 비친다
//   ② 바닥 격자: 가운데서 멀어질수록 흐려져 끝선 없이 바탕에 녹아든다(GridHelper는 네모 끝선이 보였다)
//   ③ 그림자: 벽 아래 부드러운 그림자(그림자만 받는 투명 바닥)
// 색·세기는 무대를 감싼 요소의 CSS 변수(--stage-*)에서 읽는다 → 밝은 무대·어두운 무대를 CSS만으로 바꾼다.
import * as THREE from "three";

export function stageVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** 가운데서 멀어질수록 흐려지는 바닥 격자 (1m 칸 + 5m 굵은 칸) */
export function makeFadingGrid(o: { center: THREE.Vector3; radius: number; y: number; color: string; alpha: number; dots?: boolean }) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(o.color) },
      uAlpha: { value: o.alpha },
      uCenter: { value: new THREE.Vector2(o.center.x, o.center.z) },
      uRadius: { value: o.radius },
      uDots: { value: o.dots ? 1 : 0 },
    },
    vertexShader: [
      "varying vec3 vW;",
      "void main() {",
      "  vec4 w = modelMatrix * vec4(position, 1.0);",
      "  vW = w.xyz;",
      "  gl_Position = projectionMatrix * viewMatrix * w;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 uColor;",
      "uniform float uAlpha;",
      "uniform vec2 uCenter;",
      "uniform float uRadius;",
      "uniform float uDots;",
      "varying vec3 vW;",
      "float grid(float s) {",
      "  vec2 c = vW.xz / s;",
      "  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);",
      "  return 1.0 - min(min(g.x, g.y), 1.0);",
      "}",
      "float dots(float s) {",
      "  vec2 c = vW.xz / s;",
      "  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);",
      "  return 1.0 - smoothstep(0.6, 1.6, length(g) * 0.5);",
      "}",
      "void main() {",
      "  float l = uDots > 0.5 ? dots(1.0) : max(grid(1.0) * 0.55, grid(5.0));",
      "  float d = length(vW.xz - uCenter) / uRadius;",
      "  float a = l * uAlpha * (1.0 - smoothstep(0.2, 1.0, d));",
      "  if (a < 0.004) discard;",
      "  gl_FragColor = vec4(uColor, a);",
      "  #include <colorspace_fragment>",
      "}",
    ].join("\n"),
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.radius * 2.2, o.radius * 2.2), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(o.center.x, o.y, o.center.z);
  mesh.renderOrder = -1;
  return mesh;
}

/** 그림자만 받는 투명 바닥 */
export function makeShadowFloor(o: { center: THREE.Vector3; size: number; y: number; opacity: number }) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.size, o.size), new THREE.ShadowMaterial({ opacity: o.opacity }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(o.center.x, o.y, o.center.z);
  mesh.receiveShadow = true;
  return mesh;
}
