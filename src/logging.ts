import pino from 'pino';

export const logger = pino({
  name: 'review-mcp',
  level: process.env.CAD_LOG_LEVEL ?? 'info',
  base: {
    service: 'review-mcp',
    traceId: process.env.CAD_TRACE_ID,
    runId: process.env.CAD_TRACE_RUN_ID,
  },
  redact: {
    paths: ['apiKey', 'authorization', '*.apiKey', '*.authorization'],
    censor: '[REDACTED]',
  },
}, pino.destination(2));

export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
  message?: string,
): void {
  if (process.env.CAD_TRACE_FORMAT === 'human') {
    if (event === 'tool.started') return;
    const color = process.env.CAD_TRACE_COLOR !== '0';
    const paint = (code: string, value: string) => color ? `\u001b[${code}m${value}\u001b[0m` : value;
    const tool = typeof fields.tool === 'string' ? fields.tool : undefined;
    const duration = typeof fields.durationMs === 'number' ? ` (${fields.durationMs}ms)` : '';
    const error = typeof fields.error === 'string' ? `: ${fields.error}` : '';
    const line = event === 'tool.completed'
      ? `${paint('32', '[review-mcp] [ok]')} ${paint('33', tool ?? 'tool')}${duration}`
      : event === 'tool.failed'
        ? `${paint('31', '[review-mcp] [fail]')} ${paint('33', tool ?? 'tool')}${duration}${error}`
        : event === 'server.ready'
          ? paint('36', `[review-mcp] ready protocol=${fields.protocol ?? '?'}`)
          : `[review-mcp] ${event}${message ? ` ${message}` : ''}`;
    process.stderr.write(`${line}\n`);
    return;
  }
  logger.info({ event, ...fields }, message);
}
