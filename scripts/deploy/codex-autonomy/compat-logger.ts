/** Legacy-service compatible logger used by the surgical VPS bundle. */
export const logger = {
  debug: (...args: unknown[]) => console.debug(new Date().toISOString(), ...args),
  info: (...args: unknown[]) => console.log(new Date().toISOString(), ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), ...args),
};

export type Logger = typeof logger;
