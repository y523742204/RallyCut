import type { NextConfig } from "next";

// better-sqlite3 是 native 模块, 必须在 server 端外部依赖
// 中, 否则 Webpack/Turbopack 会把它打包导致 .node 二进制找不到.
//
// allowedDevOrigins 放行 e2b sandbox 反代域名 (*.e2b.app / *.e2b.dev).
// Next 15.2.2+ 在 dev 模式对 _next/* 端点 (含 webpack-hmr WebSocket) 启用 cross-origin
// 校验, 默认仅允许 localhost; e2b sandbox 通过子域名反代 3000 端口, origin 非 localhost
// 会被拒, 表现为浏览器控制台不断刷 wss 连接失败. 详见 vercel/next.js#77253.
const nextConfig: NextConfig = {
  // 纯静态导出: 构建产物为 out/ 目录, 可托管到任意 CDN / 对象存储, 无需 Node 服务器.
  output: "export",
  // GitHub Pages 项目站点托管在 https://<user>.github.io/RallyCut/ 子路径下.
  basePath: "/RallyCut",
  // 同步注入到客户端 bundle, 供 lib/export-mp4.ts 拼接 /ffmpeg 静态资源路径.
  env: { NEXT_PUBLIC_BASE_PATH: "/RallyCut" },
  allowedDevOrigins: ["*.e2b.app", "*.e2b.dev"],
};

export default nextConfig;
