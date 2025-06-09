import winston from "winston";
import env from "./env";

const logger = winston.createLogger({
  level: env.DEBUG ? "debug" : "info",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.simple(),
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
