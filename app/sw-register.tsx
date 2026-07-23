'use client';

import { useEffect } from 'react';

// 生产环境下注册 Service Worker (PWA 离线缓存). 开发模式不注册, 避免缓存干扰调试.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    navigator.serviceWorker.register(`${base}/sw.js`).catch(() => undefined);
  }, []);
  return null;
}
