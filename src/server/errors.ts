import {ValidationIssue} from "../templates/validation";

/** Error carrying an HTTP status and a machine readable code. Rendered by the error middleware. */
export class HttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message)
        this.name = 'HttpError'
    }
}

export class NotFoundError extends HttpError {
    constructor(what: string) {
        super(404, 'NOT_FOUND', `${what} not found`)
    }
}

export class ConflictError extends HttpError {
    constructor(message: string, details?: unknown) {
        super(409, 'CONFLICT', message, details)
    }
}

export class BadRequestError extends HttpError {
    constructor(message: string, details?: unknown) {
        super(400, 'BAD_REQUEST', message, details)
    }
}

export class ValidationError extends HttpError {
    constructor(public readonly issues: ValidationIssue[], message = 'Validation failed') {
        super(422, 'VALIDATION_FAILED', message, {issues})
    }
}

/** Wire format of every error response. */
export interface ErrorResponse {
    error: {
        code: string
        message: string
        issues?: ValidationIssue[]
        details?: unknown
    }
}
