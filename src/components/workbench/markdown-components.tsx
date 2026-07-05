import CodeBlock from './CodeBlock'

export const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    const code = String(children).replace(/\n$/, '')
    if (match) {
      return <CodeBlock language={match[1]} code={code} />
    }
    // 无语言标注的多行代码块（含换行）也用 CodeBlock 渲染，避免被当作行内 code（A#6）
    if (code.includes('\n')) {
      return <CodeBlock language="text" code={code} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
  a({ href, children, ...props }: any) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
}
