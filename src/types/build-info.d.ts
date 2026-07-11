// vite.config.ts 的 define 注入的全局常量，由 scripts/generate-build-info.mjs 生成
// predev/prebuild 自动触发，dev 与 build 都会先生成 build-info.json
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILD_TIME__: string
