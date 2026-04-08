/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 从 package.json 注入 */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** 邮件 API 根地址（生产环境若与前端不同域则设为完整 URL，如 https://mail.example.com） */
  readonly VITE_EMAIL_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
