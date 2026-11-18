import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../../../errors/AppError.js";

import {
    MAX_FILE_SIZE,
    ALLOWED_MIME_TYPES,
} from "../../../config/storage.js";

import {
    ticketParamsSchema,
} from "../ticket.schema.js";

const attachmentParamsSchema = ticketParamsSchema.extend({
    attachmentId: z.uuid(),
});

type AttachmentMimeType =
    typeof ALLOWED_MIME_TYPES[number];

type ValidatedAttachment = {
    buffer: Buffer;
    fileName: string;
    mimeType: AttachmentMimeType;
    sizeBytes: number;
};

const MIME_EXTENSIONS: Record<
    AttachmentMimeType,
    readonly string[]
> = {
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/webp": [".webp"],
    "application/pdf": [".pdf"],
};

const sanitizeFileName = (value: string): string => {
    const name = value
        .normalize("NFKC")
        .replace(/[\x00-\x1F\x7F]/g, "")
        .replace(/[\/\\:*?"<>|]/g, "_")
        .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
        .trim();

    if (
        !name ||
        name === "." ||
        name === ".." ||
        Buffer.byteLength(name, "utf8") > 255
    ) {
        throw new AppError("Invalid filename", 400);
    }

    return name;
};

const isAllowedMimeType = (
    value: string
): value is AttachmentMimeType => {
    return ALLOWED_MIME_TYPES.some(
        (mimeType) => mimeType === value
    );
};

const validateAttachment = async (
    file: Express.Multer.File | undefined
): Promise<ValidatedAttachment> => {
    if (!file || file.buffer.length === 0) {
        throw new AppError("A file is required", 400);
    }

    if (file.buffer.length > MAX_FILE_SIZE) {
        throw new AppError("File exceeds size limit", 413);
    }

    let detectedType;

    try {
        detectedType = await fileTypeFromBuffer(
            file.buffer
        );
    } catch {
        throw new AppError("Invalid file signature", 415);
    }

    if (
        !detectedType ||
        !isAllowedMimeType(detectedType.mime) ||
        detectedType.mime !== file.mimetype
    ) {
        throw new AppError(
            "Unsupported or invalid file type",
            415
        );
    }

    const fileName = sanitizeFileName(file.originalname);

    const extension = fileName
        .slice(fileName.lastIndexOf("."))
        .toLowerCase();

    if (
        !MIME_EXTENSIONS[detectedType.mime].includes(
            extension
        )
    ) {
        throw new AppError(
            "Filename extension does not match file type",
            415
        );
    }

    return {
        buffer: file.buffer,
        fileName,
        mimeType: detectedType.mime,
        sizeBytes: file.buffer.length,
    };
};

export {
    attachmentParamsSchema,
    validateAttachment,
};

export type {
    ValidatedAttachment,
};