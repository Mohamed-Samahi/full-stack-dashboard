import express from "express";

import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { AppError } from "../../errors/AppError.js";

import {
    authenticate,
} from "../../middlewares/auth.middleware.js";

import {
    authorize,
} from "../../middlewares/authorize.middleware.js";

import {
    validate,
} from "../../middlewares/validate.middleware.js";

import {
    PERMISSIONS,
} from "../rbac/rbac.constants.js";

import {
    assertSupportedRole,
    getAssignmentPermission,
} from "./ticket.authorization.js";

import {
    ticketParamsSchema,
    createTicketSchema,
    updateTicketSchema,
    assignTicketSchema,
    updateTicketStatusSchema,
    listTicketsQuerySchema,
} from "./ticket.schema.js";

import {
    createTicket,
    getTickets,
    getTicketById,
    updateTicket,
    assignTicket,
    updateTicketStatus,
} from "./ticket.controller.js";

import {
    createCommentSchema,
} from "./comments/comment.schema.js";

import {
    getComments,
    createComment,
    streamComments,
} from "./comments/comment.controller.js";

import {
    uploadAttachment,
} from "../../middlewares/upload.middleware.js";

import {
    attachmentParamsSchema,
} from "./attachments/attachment.schema.js";

import {
    authorizeAttachmentUpload,
    createAttachment,
    getAttachments,
    getAttachmentDownload,
} from "./attachments/attachment.controller.js";

const router = express.Router();

const requireSupportedRole = (
    request: Request,
    _response: Response,
    next: NextFunction
) => {
    if (!request.user) {
        throw new AppError(
            "Authentication required",
            401
        );
    }

    assertSupportedRole(request.user);

    next();
};

const authorizeAssignment = (
    request: Request,
    response: Response,
    next: NextFunction
) => {
    if (!request.user) {
        throw new AppError(
            "Authentication required",
            401
        );
    }

    const permission = getAssignmentPermission(
        request.user
    );

    return authorize(permission)(
        request,
        response,
        next
    );
};

router.use(
    authenticate,
    requireSupportedRole
);

router.post(
    "/",
    authorize(PERMISSIONS.TICKET_CREATE),
    validate(createTicketSchema),
    createTicket
);

router.get(
    "/",
    authorize(PERMISSIONS.TICKET_READ),
    validate(listTicketsQuerySchema, "query"),
    getTickets
);

router.get(
    "/:ticketId",
    authorize(PERMISSIONS.TICKET_READ),
    validate(ticketParamsSchema, "params"),
    getTicketById
);

router.patch(
    "/:ticketId",
    authorize(PERMISSIONS.TICKET_UPDATE),
    validate(ticketParamsSchema, "params"),
    validate(updateTicketSchema),
    updateTicket
);

router.patch(
    "/:ticketId/assignment",
    authorizeAssignment,
    validate(ticketParamsSchema, "params"),
    validate(assignTicketSchema),
    assignTicket
);

router.patch(
    "/:ticketId/status",
    authorize(PERMISSIONS.TICKET_TRANSITION),
    validate(ticketParamsSchema, "params"),
    validate(updateTicketStatusSchema),
    updateTicketStatus
);

router.get(
    "/:ticketId/comments",
    authorize(PERMISSIONS.TICKET_READ),
    validate(ticketParamsSchema, "params"),
    getComments
);

router.post(
    "/:ticketId/comments",
    authorize(PERMISSIONS.TICKET_COMMENT),
    validate(ticketParamsSchema, "params"),
    validate(createCommentSchema),
    createComment
);

router.get(
    "/:ticketId/comments/events",
    authorize(PERMISSIONS.TICKET_READ),
    validate(ticketParamsSchema, "params"),
    streamComments
);

router.post(
    "/:ticketId/attachments",
    authorize(PERMISSIONS.TICKET_ATTACH),
    validate(ticketParamsSchema, "params"),
    authorizeAttachmentUpload,
    uploadAttachment,
    createAttachment
);

router.get(
    "/:ticketId/attachments",
    authorize(PERMISSIONS.TICKET_READ),
    validate(ticketParamsSchema, "params"),
    getAttachments
);

router.get(
    "/:ticketId/attachments/:attachmentId/download",
    authorize(PERMISSIONS.TICKET_READ),
    validate(attachmentParamsSchema, "params"),
    getAttachmentDownload
);

export default router;