import multer from "multer";

import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { AppError } from "../errors/AppError.js";

import {
    MAX_FILE_SIZE,
} from "../config/storage.js";

const UPLOAD_TIMEOUT_MS = 30_000;

const MAX_REQUEST_SIZE =
    MAX_FILE_SIZE + 64 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: MAX_FILE_SIZE + 1,
        files: 1,
        fields: 0,
        parts: 2,
        fieldNameSize: 100,
        headerPairs: 100,
    },
}).single("file");

const uploadAttachment = (
    request: Request,
    response: Response,
    next: NextFunction
): void => {
    if (!request.is("multipart/form-data")) {
        next(
            new AppError(
                "Multipart form data required",
                400
            )
        );

        return;
    }

    const contentLength =
        request.headers["content-length"];

    if (
        contentLength !== undefined &&
        Number(contentLength) > MAX_REQUEST_SIZE
    ) {
        next(new AppError("Request too large", 413));
        return;
    }

    let receivedBytes = 0;
    let completed = false;

    const timer = setTimeout(() => {
        finish(new AppError("Upload timed out", 408));
    }, UPLOAD_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
        receivedBytes += chunk.length;

        if (receivedBytes > MAX_REQUEST_SIZE) {
            finish(new AppError("Request too large", 413));
        }
    };

    const onAborted = () => {
        finish(new AppError("Upload aborted", 400));
    };

    const finish = (error?: Error) => {
        if (completed) return;

        completed = true;

        clearTimeout(timer);

        request.off("data", onData);
        request.off("aborted", onAborted);

        if (error) {
            response.setHeader("Connection", "close");

            response.once("finish", () => {
                if (!request.complete) {
                    request.destroy();
                }
            });

            next(error);
            return;
        }

        next();
    };

    request.on("data", onData);
    request.once("aborted", onAborted);

    upload(request, response, (error: unknown) => {
        if (completed) return;

        if (error instanceof multer.MulterError) {
            const status = error.code === "LIMIT_FILE_SIZE"
                ? 413
                : 400;

            finish(
                new AppError(
                    status === 413
                        ? "File exceeds size limit"
                        : "Invalid multipart upload",
                    status
                )
            );

            return;
        }

        if (error) {
            finish(
                new AppError(
                    "Malformed multipart upload",
                    400
                )
            );

            return;
        }

        if (!request.file) {
            finish(new AppError("A file is required", 400));
            return;
        }

        if (request.file.buffer.length > MAX_FILE_SIZE) {
            finish(
                new AppError(
                    "File exceeds size limit",
                    413
                )
            );

            return;
        }

        finish();
    });
};

export {
    uploadAttachment,
};