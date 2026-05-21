declare module 'react-syntax-highlighter/dist/esm/languages/prism' {
  const languages: Record<string, any>
  export default languages
  export const javascript: any
  export const typescript: any
  export const python: any
  export const java: any
  export const cpp: any
  export const c: any
  export const go: any
  export const rust: any
  export const bash: any
  export const sql: any
  export const json: any
  export const yaml: any
  export const markdown: any
  export const html: any
  export const css: any
  export const jsx: any
  export const tsx: any
  export const shell: any
  export const powershell: any
  export const diff: any
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-dark' {
  const oneDark: Record<string, React.CSSProperties>
  export default oneDark
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-light' {
  const oneLight: Record<string, React.CSSProperties>
  export default oneLight
}
