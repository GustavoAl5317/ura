import { createLogger, format, transports } from 'winston';
import { config } from './config';

const level =
  config.debug.logLevel === 'full' || config.debug.logLevel === 'verbose'
    ? 'debug'
    : config.debug.logLevel;

export const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss.SSS' }),
    format.colorize(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const m = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level}] ${message}${m}`;
    }),
  ),
  transports: [new transports.Console()],
});
