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

/**
 * A request the server cannot take as it is (`BAD_PAYLOAD` with its status): a body that is no JSON
 * object, too large or of another type, or a query value that is no integer. Here, beside the
 * validation error, so the readers of the operation registry can throw it in the browser demo too.
 */
export class HttpPayloadError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpPayloadError";
    this.statusCode = statusCode;
  }
}
