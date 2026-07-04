/**
 * Type declaration for Vite `?raw` text imports. The renderer already gets this
 * from `vite/client`, but the main-process build (tsconfig.node) only has
 * `electron-vite/node` types, so declare the specific `*.txt?raw` shape here so
 * `prompt-text.ts` type-checks in both bundles.
 */
declare module '*.txt?raw' {
  const content: string
  export default content
}
