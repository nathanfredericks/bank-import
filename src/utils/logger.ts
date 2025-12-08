const logger = {
  debug: (message: string, ...meta: any[]) => {
    console.log(JSON.stringify({ level: "debug", message, ...meta }));
  },
  info: (message: string, ...meta: any[]) => {
    console.log(JSON.stringify({ level: "info", message, ...meta }));
  },
  warn: (message: string, ...meta: any[]) => {
    console.warn(JSON.stringify({ level: "warn", message, ...meta }));
  },
  error: (message: string | Error, ...meta: any[]) => {
    if (message instanceof Error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: message.message,
          stack: message.stack,
          ...meta,
        }),
      );
    } else {
      console.error(JSON.stringify({ level: "error", message, ...meta }));
    }
  },
};

export default logger;
