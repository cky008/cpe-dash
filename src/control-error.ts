/**
 * A request the daemon refuses before any router session (`400 VALIDATION_ERROR`). Its own module
 * so the input guards in control-input.ts stay free of Node built-ins for the browser demo.
 */
export class CpeControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpeControlValidationError";
  }
}
