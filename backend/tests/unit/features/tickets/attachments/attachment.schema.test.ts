import { randomUUID } from "node:crypto";

import {
    describe,
    expect,
    it,
} from "vitest";

import {
    MAX_FILE_SIZE,
} from "../../../../../src/config/storage.js";

import {
    attachmentParamsSchema,
    validateAttachment,
} from "../../../../../src/features/tickets/attachments/attachment.schema.js";

import {
    PNG,
    INVALID,
    validFileFixtures,
    createMulterFile,
} from "../../../../fixtures/files/attachment.fixtures.js";

describe("Attachment validation", () => {
    it.each(validFileFixtures)(
        "accepts $mimeType",
        async ({ buffer, fileName, mimeType }) => {
            const result = await validateAttachment(
                createMulterFile({
                    buffer,
                    originalname: fileName,
                    mimetype: mimeType,
                    size: buffer.length,
                })
            );

            expect(result).toEqual({
                buffer,
                fileName,
                mimeType,
                sizeBytes: buffer.length,
            });
        }
    );

    it("rejects a missing file", async () => {
        await expect(
            validateAttachment(undefined)
        ).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it("rejects an empty file", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    buffer: Buffer.alloc(0),
                    size: 0,
                })
            )
        ).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it("accepts the configured maximum file size", async () => {
        const buffer = Buffer.alloc(MAX_FILE_SIZE);

        PNG.copy(buffer);

        await expect(
            validateAttachment(
                createMulterFile({ buffer })
            )
        ).resolves.toMatchObject({
            sizeBytes: MAX_FILE_SIZE,
        });
    });

    it("rejects files larger than the maximum", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    buffer: Buffer.alloc(
                        MAX_FILE_SIZE + 1
                    ),
                })
            )
        ).rejects.toMatchObject({
            statusCode: 413,
        });
    });

    it("derives size from the actual buffer", async () => {
        const result = await validateAttachment(
            createMulterFile({
                size: 999999,
            })
        );

        expect(result.sizeBytes).toBe(PNG.length);
    });

    it("rejects invalid file signatures", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    buffer: INVALID,
                })
            )
        ).rejects.toMatchObject({
            statusCode: 415,
        });
    });

    it("rejects truncated binary signatures", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    buffer: PNG.subarray(0, 4),
                })
            )
        ).rejects.toMatchObject({
            statusCode: 415,
        });
    });

    it("rejects unsupported binary formats", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    buffer: Buffer.from(
                        "47494638396101000100000000",
                        "hex"
                    ),
                    originalname: "image.gif",
                    mimetype: "image/gif",
                })
            )
        ).rejects.toMatchObject({
            statusCode: 415,
        });
    });

    it.each([
        "image/jpeg",
        "application/pdf",
        "application/octet-stream",
        "text/html",
    ])(
        "rejects misleading MIME type %s",
        async (mimetype) => {
            await expect(
                validateAttachment(
                    createMulterFile({ mimetype })
                )
            ).rejects.toMatchObject({
                statusCode: 415,
            });
        }
    );

    it.each([
        "image.jpg",
        "image.pdf",
        "image.png.exe",
        "image",
    ])(
        "rejects misleading extension %s",
        async (originalname) => {
            await expect(
                validateAttachment(
                    createMulterFile({
                        originalname,
                    })
                )
            ).rejects.toMatchObject({
                statusCode: 415,
            });
        }
    );

    it("accepts uppercase extensions", async () => {
        await expect(
            validateAttachment(
                createMulterFile({
                    originalname: "IMAGE.PNG",
                })
            )
        ).resolves.toMatchObject({
            fileName: "IMAGE.PNG",
        });
    });

    it("sanitizes path separators and control characters", async () => {
        const result = await validateAttachment(
            createMulterFile({
                originalname:
                    "../folder\\unsafe:\u0000\u202E.png",
            })
        );

        expect(result.fileName).toBe(
            ".._folder_unsafe_.png"
        );

        expect(result.fileName).not.toMatch(
            /[\/\\:\x00\u202E]/
        );
    });

    it.each([
        "",
        " ",
        ".",
        "..",
        `${"a".repeat(256)}.png`,
    ])(
        "rejects invalid filenames",
        async (originalname) => {
            await expect(
                validateAttachment(
                    createMulterFile({ originalname })
                )
            ).rejects.toMatchObject({
                statusCode: 400,
            });
        }
    );

    it("accepts valid UUID parameters", () => {
        expect(
            attachmentParamsSchema.safeParse({
                ticketId: randomUUID(),
                attachmentId: randomUUID(),
            }).success
        ).toBe(true);
    });

    it.each([
        {
            ticketId: "invalid",
            attachmentId: randomUUID(),
        },
        {
            ticketId: randomUUID(),
            attachmentId: "invalid",
        },
        {
            ticketId: randomUUID(),
        },
        {
            ticketId: randomUUID(),
            attachmentId: randomUUID(),
            extra: true,
        },
    ])("rejects invalid parameters", (params) => {
        expect(
            attachmentParamsSchema.safeParse(params)
                .success
        ).toBe(false);
    });
});