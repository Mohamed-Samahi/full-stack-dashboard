import type {
    Request,
    Response,
    NextFunction,
} from "express";

import {
    getActor,
    getTicketId,
} from "../ticket.controller.js";

import {
    attachmentParamsSchema,
    validateAttachment,
} from "./attachment.schema.js";

import * as attachmentService
    from "./attachment.service.js";

const authorizeAttachmentUpload = async (
    request: Request,
    _response: Response,
    next: NextFunction
): Promise<void> => {
    await attachmentService.assertAttachmentUploadAllowed(
        getActor(request),
        getTicketId(request)
    );

    next();
};

const createAttachment = async (
    request: Request,
    response: Response
): Promise<void> => {
    const file = await validateAttachment(
        request.file
    );

    const attachment =
        await attachmentService.createAttachment(
            getActor(request),
            getTicketId(request),
            file
        );

    response.status(201).json({
        data: attachment,
    });
};

const getAttachments = async (
    request: Request,
    response: Response
): Promise<void> => {
    const attachments =
        await attachmentService.getAttachments(
            getActor(request),
            getTicketId(request)
        );

    response.status(200).json({
        data: attachments,
    });
};

const getAttachmentDownload = async (
    request: Request,
    response: Response
): Promise<void> => {
    const { ticketId, attachmentId } =
        attachmentParamsSchema.parse(request.params);

    const download =
        await attachmentService.getAttachmentDownload(
            getActor(request),
            ticketId,
            attachmentId
        );

    response.setHeader(
        "Cache-Control",
        "no-store, private"
    );

    response.status(200).json({
        data: download,
    });
};

export {
    authorizeAttachmentUpload,
    createAttachment,
    getAttachments,
    getAttachmentDownload,
};