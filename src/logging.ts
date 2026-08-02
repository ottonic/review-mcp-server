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
    const details = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    process.stderr.write(
      `[review-mcp] ${event}${details ? ` ${details}` : ''}${message ? ` ${message}` : ''}\n`,
    );
    return;
  }
  logger.info({ event, ...fields }, message);
}
