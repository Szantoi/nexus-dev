"use strict";
/** Legacy-service compatible logger used by the surgical VPS bundle. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.logger = {
  debug: (...args) => console.debug(new Date().toISOString(), ...args),
  info: (...args) => console.log(new Date().toISOString(), ...args),
  warn: (...args) => console.warn(new Date().toISOString(), ...args),
  error: (...args) => console.error(new Date().toISOString(), ...args),
};
