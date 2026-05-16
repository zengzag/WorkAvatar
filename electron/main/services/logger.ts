type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_PREFIXES: Record<string, string> = {
  DB: '[DB]',
  KB: '[KB]',
  'KB-DB': '[KB-DB]',
  Agent: '[Agent]',
  AgentEvent: '[AgentEvent]',
  Scheduler: '[Scheduler]',
  TaskQueue: '[TaskQueue]',
  OCR: '[OCR]',
  LLM: '[LLM]',
  Export: '[Export]',
  Search: '[Search]',
}

class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  private formatMessage(level: LogLevel, message: string): string {
    const prefix = LOG_PREFIXES[this.module] || `[${this.module}]`
    return `${prefix} [${level.toUpperCase()}] ${message}`
  }

  debug(message: string, ...args: any[]) {
    console.log(this.formatMessage('debug', message), ...args)
  }

  info(message: string, ...args: any[]) {
    console.log(this.formatMessage('info', message), ...args)
  }

  warn(message: string, ...args: any[]) {
    console.warn(this.formatMessage('warn', message), ...args)
  }

  error(message: string, ...args: any[]) {
    console.error(this.formatMessage('error', message), ...args)
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module)
}

export { Logger }
