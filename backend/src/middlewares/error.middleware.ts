import type { NextFunction, Request, Response } from "express";

import { ZodError } from "zod";

import { AppError } from "../errors/AppError.js";

import logger from "../config/logger.js";

export const errorHandler = (
    error: Error,
    _request: Request,
    response: Response,
    _next: NextFunction
) => {
    // Validation errors
    if (error instanceof ZodError) {
        return response.status(400).json({
            status: "error",
            message: "Validation failed",
            errors: error.issues,
        });
    }

    // Expected application errors
    if (error instanceof AppError) {
        return response.status(error.statusCode).json({
            status: "error",
            message: error.message,
        });
    }

    const errorType =
        "type" in error ? error.type : undefined;

    if (errorType === "entity.too.large") {
        return response.status(413).json({
            status: "error",
            message: "Request payload too large",
        });
    }

    if (
        errorType === "entity.parse.failed" ||
        errorType === "request.aborted" ||
        errorType === "request.size.invalid"
    ) {
        return response.status(400).json({
            status: "error",
            message: "Malformed request payload",
        });
    }

    // Unexpected errors
    logger.error("Unexpected application error", {
        error,
    });

    return response.status(500).json({
        status: "error",
        message: "Internal server error",
    });
};