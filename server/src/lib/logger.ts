type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVEL_ORDER.info;

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const logger = {
  debug: (scope: string, message: string, extra?: unknown) => emit('debug', scope, message, extra),
  info: (scope: string, message: string, extra?: unknown) => emit('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => emit('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => emit('error', scope, message, extra),
};
