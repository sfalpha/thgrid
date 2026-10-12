import {NextFunction, Request, RequestHandler, Response} from "express";

/** Express 4 does not forward rejected promises to the error middleware; this wrapper does. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
    return (req, res, next) => {
        fn(req, res, next).catch(next)
    }
}

export function queryFlag(value: unknown): boolean {
    return value === 'true' || value === '1' || value === ''
}
