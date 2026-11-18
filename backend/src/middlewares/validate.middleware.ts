import type {
    NextFunction,
    Request,
    Response,
} from "express";

import type { ZodType } from "zod";

type RequestPart = "body" | "params" | "query";

export const validate = (
    schema: ZodType,
    part: RequestPart = "body"
) => {
    return (
        request: Request,
        response: Response,
        next: NextFunction
    ) => {
        const result = schema.parse(request[part]);

        if (part === "body") {
            request.body = result;
        }

        if (part === "query") {
            response.locals.validatedQuery = result;
        }

        next();
    };
};