import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 第三方压缩产物 (ffmpeg.wasm UMD bundle), 不应参与 lint:
    "public/ffmpeg/**",
    // gh-pages 发布产物目录 (minified build output):
    "gh-pages-deploy/**",
    // 本地静态产物验证脚本, 非应用代码:
    "static-server.js",
    // Service Worker 运行在独立全局作用域 (self/caches), 不参与 lint:
    "public/sw.js",
  ]),
]);

export default eslintConfig;
