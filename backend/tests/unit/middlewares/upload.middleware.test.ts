import express from "express";
import request from "supertest";

import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import type {
    Request,
    Response,
} from "express";

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import {
    uploadAttachment,
} from "../../../src/middlewares/upload.middleware.js";

import {
    errorHandler,
} from "../../../src/middlewares/error.middleware.js";

import {
    MAX_FILE_SIZE,
} from "../../../src/config/storage.js";

import {
    PNG,
} from "../../fixtures/files/attachment.fixtures.js";

const app = express();

app.post(
    "/upload",
    uploadAttachment,
    (req, res) => {
        res.status(200).json({
            fileName: req.file?.originalname,
            size: req.file?.size,
        });
    }
);

app.use(errorHandler);

const api = request(app);

describe("Attachment multipart middleware", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("accepts exactly one file", async () => {
        const response = await api
            .post("/upload")
            .attach("file", PNG, {
                filename: "image.png",
                contentType: "image/png",
            })
            .expect(200);

        expect(response.body).toEqual({
            fileName: "image.png",
            size: PNG.length,
        });
    });

    it("rejects non-multipart requests", async () => {
        await api
            .post("/upload")
            .send({ file: "invalid" })
            .expect(400);
    });

    it("rejects multipart requests without a boundary", async () => {
        await api
            .post("/upload")
            .set("Content-Type", "multipart/form-data")
            .send("invalid multipart body")
            .expect(400);
    });

    it("rejects missing files", async () => {
        await api
            .post("/upload")
            .set(
                "Content-Type",
                "multipart/form-data; boundary=test"
            )
            .send("--test--\r\n")
            .expect(400);
    });

    it("rejects malformed multipart bodies", async () => {
        await api
            .post("/upload")
            .set(
                "Content-Type",
                "multipart/form-data; boundary=test"
            )
            .send(
                "--test\r\n" +
                'Content-Disposition: form-data; ' +
                'name="file"; filename="image.png"\r\n' +
                "Content-Type: image/png\r\n\r\n" +
                "incomplete body"
            )
            .expect(400);
    });

    it("rejects unexpected upload field names", async () => {
        await api
            .post("/upload")
            .attach("attachment", PNG, "image.png")
            .expect(400);
    });

    it("rejects multiple uploaded files", async () => {
        await api
            .post("/upload")
            .attach("file", PNG, "first.png")
            .attach("file", PNG, "second.png")
            .expect(400);
    });

    it("rejects additional multipart fields", async () => {
        await api
            .post("/upload")
            .field("uploadedById", "spoofed")
            .attach("file", PNG, "image.png")
            .expect(400);
    });

    it("accepts a file at the exact size limit", async () => {
        await api
            .post("/upload")
            .attach(
                "file",
                Buffer.alloc(MAX_FILE_SIZE),
                "image.png"
            )
            .expect(200);
    });

    it("rejects files above the size limit", async () => {
        await api
            .post("/upload")
            .attach(
                "file",
                Buffer.alloc(MAX_FILE_SIZE + 1),
                "image.png"
            )
            .expect(413);
    });

    it("rejects requests above the total request limit", () => {
        const req = {
            is: vi.fn().mockReturnValue(true),

            headers: {
                "content-type":
                    "multipart/form-data; boundary=test",

                "content-length": String(
                    MAX_FILE_SIZE + 64 * 1024 + 1
                ),
            },
        } as unknown as Request;

        const res = {} as Response;
        const next = vi.fn();

        uploadAttachment(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 413,
                message: "Request too large",
            })
        );
    });

    const createStreamingRequest = () => {
        const stream = new PassThrough();

        const req = Object.assign(stream, {
            headers: {
                "content-type":
                    "multipart/form-data; boundary=test",

                "transfer-encoding": "chunked",
            },

            is: vi.fn().mockReturnValue(
                "multipart/form-data"
            ),

            complete: false,
        });

        const res = Object.assign(
            new EventEmitter(),
            {
                setHeader: vi.fn(),
            }
        );

        return { req, res };
    };

    it("rejects stalled uploads after 30 seconds", async () => {
        vi.useFakeTimers();

        const { req, res } =
            createStreamingRequest();

        const next = vi.fn();

        try {
            uploadAttachment(
                req as unknown as Request,
                res as unknown as Response,
                next
            );

            await vi.advanceTimersByTimeAsync(
                29_999
            );

            expect(next).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);

            expect(next).toHaveBeenCalledTimes(1);

            expect(next).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 408,
                    message: "Upload timed out",
                })
            );

            expect(res.setHeader)
                .toHaveBeenCalledWith(
                    "Connection",
                    "close"
                );
        } finally {
            res.emit("finish");
            req.destroy();
        }
    });

    it("enforces request limits for chunked uploads", () => {
        const { req, res } =
            createStreamingRequest();

        const next = vi.fn();

        try {
            uploadAttachment(
                req as unknown as Request,
                res as unknown as Response,
                next
            );

            req.write(
                Buffer.alloc(
                    MAX_FILE_SIZE + 64 * 1024 + 1
                )
            );

            expect(next).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 413,
                })
            );

            expect(next).toHaveBeenCalledTimes(1);
        } finally {
            res.emit("finish");
            req.destroy();
        }
    });
});