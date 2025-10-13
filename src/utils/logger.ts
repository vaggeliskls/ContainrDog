import winston from 'winston';
import { getConfig } from './config';

const createLogger = () => {
  const config = getConfig();

  return winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    ),
    defaultMeta: { service: 'containrdog' },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(
            ({ level, message, timestamp, ...metadata }) => {
              let msg = `${timestamp} [${level}]: ${message}`;
              if (Object.keys(metadata).length > 0 && metadata.service !== 'containrdog') {
                msg += ` ${JSON.stringify(metadata)}`;
              }
              return msg;
            }
          )
        ),
      }),
    ],
  });
};

export const logger = createLogger();
