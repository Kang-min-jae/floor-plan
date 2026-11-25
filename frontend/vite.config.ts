import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const design = fileURLToPath(new URL("../design/components", import.meta.url));

// /api를 넘길 백엔드. 기본은 로컬(localhost:8000).
// 팀 서버(실제 모델)로 시험할 때: frontend/.env.local에 VITE_PROXY_TARGET=http://<서버 주소> 한 줄 (코드 수정 없음)
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), "").VITE_PROXY_TARGET || "http://localhost:8000";
  const proxy = { "/api": target, "/health": target };
  return {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@design": design },
    // design/ 는 frontend 밖에 있어서, react를 frontend/node_modules 하나에서만 찾게 한다
    dedupe: ["react", "react-dom"],
  },
  server: {
    fs: { allow: [".."] },
    proxy, // 로컬 개발: /api·/health를 백엔드로 전달
  },
  preview: { proxy },
  };
});
