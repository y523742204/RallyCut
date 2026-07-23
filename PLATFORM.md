# 运行平台约束 (开始写代码前必读)

这个脚手架最终部署在 e2b 沙箱里, 通过**跨源 iframe** 嵌入到平台前端预览.
浏览器对 third-party iframe 有一系列默认限制, 写功能时必须按下面规则做,
否则用户在预览窗口里会遇到"看似登录成功但状态丢失 / fetch 401 / autofocus
被 block / localStorage 数据隔离"等问题.

## 0. 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript 5
- Tailwind CSS v4 (通过 @tailwindcss/postcss)
- 包管理器: **pnpm** (lockfile = pnpm-lock.yaml)
- SQLite (better-sqlite3, native 模块, 已在 next.config.ts 中声明 serverExternalPackages)

## 1. Cookie (认证 / 会话 必看)

**默认 `cookies.set("x", v)` 不可用** — Next.js 默认 `sameSite=lax`,
跨源 iframe 内浏览器会直接拦掉这条 cookie, 用户点登录后状态丢失.

写认证或任何持久会话 cookie, 一律 import 脚手架自带 helper:

```ts
import { IFRAME_SAFE_COOKIE_OPTS } from "@/lib/iframe-safe-cookie";

const res = NextResponse.json({ ok: true });
res.cookies.set("session", token, {
  ...IFRAME_SAFE_COOKIE_OPTS,
  maxAge: 60 * 60 * 8,
});
return res;
```

或更简便:

```ts
import { setSessionCookie } from "@/lib/iframe-safe-cookie";
setSessionCookie(res, "session", token);
```

不要自己拼 `sameSite / secure / partitioned` 选项, 用 helper.

## 2. 优先用 Authorization header 而非 cookie

如果业务允许, 更稳的方案是 token + `Authorization: Bearer ...` header +
浏览器端 localStorage 存 token. 这种方式不依赖 cookie, 在跨源 iframe / 新
tab / 嵌入第三方页面下行为一致.

cookie-only 模式只在"必须 httpOnly 防 XSS 偷 token" 时考虑, 且必须按 §1
配置.

## 3. 不要依赖 autofocus / 自动聚焦输入框

跨源 iframe 内 `<input autoFocus>` 会被 Chrome block 报警告
("Blocked autofocusing on a `<input>` element in a cross-origin subframe").
用户在 iframe 里仍然可以手动点击输入框, 但不要把"自动聚焦"作为 UX 关键路径.

## 4. localStorage / sessionStorage / IndexedDB 受 partition

跨源 iframe 的 storage 与同域名独立 tab 看到的不是同一份 (Chrome 的
partitioning). 业务上不要假设 "用户在新 tab 登录后, iframe 里能看到登录态" —
两个上下文 storage 互相独立.

## 5. Cross-origin form submit

`<form action="/api/login" method="POST">` 在 iframe 内仍能 POST, 但若服务端
重定向 (303 to `/`), 浏览器在跨源 iframe 上对部分 navigation 行为有限制.
用 `fetch("/api/login", { method: "POST" })` + JS 端 `router.push("/")`
更稳妥, 不依赖 form 默认 submit + 浏览器 navigation.

## 6. 客户端错误自动上报 (平台埋点, 不要删)

`lib/error-reporter.tsx` 是平台埋的客户端 component, `app/layout.tsx` 顶层
已 mount `<ErrorReporter />`. 它监听浏览器侧 4 类错误 (window.error /
unhandledrejection / fetch 5xx / 主动 reportClientError) 自动 POST 到
`app/api/luffy-platform-error/route.ts`, 后端把错误追加到 `/tmp/preview.log`,
平台层会下次用户发消息时自动喂给 LLM 看. 用户不需要复制控制台错误.

**严禁:**
- 删除 `lib/error-reporter.tsx`
- 删除 `app/api/luffy-platform-error/route.ts`
- 从 `app/layout.tsx` 移除 `<ErrorReporter />`
- 改 `luffy-platform-error` 路由路径

**业务代码主动上报错** (catch block 里有意暴露):

```ts
import { reportClientError } from "@/lib/error-reporter";

try {
  await doRiskyThing();
} catch (e) {
  reportClientError("doRiskyThing 失败", e);
  throw e;
}
```

## 7. CSRF

如果用 cookie 认证, 必须配 CSRF token (例: 在 cookie 之外存一份 random
token, 改写请求时 header 带 `X-CSRF-Token`, 服务端比对). cookie sameSite=none
模式下浏览器不会帮你过滤跨站攻击, 必须自己防.
