import type { Request } from "express";

import type {
    Prisma,
    TicketStatus,
    TicketPriority,
} from "../../generated/prisma/client.js";

type TicketActor = NonNullable<Request["user"]>;

type TicketParticipant = {
    id: string;
    name: string | null;
};

type TicketComment = {
    id: string;
    ticketId: string;
    content: string;
    author: TicketParticipant;
    createdAt: string;
};

type TicketCommentEventMap = {
    "comments.snapshot": {
        data: TicketComment[];
    };

    "comment.created": {
        data: TicketComment;
    };

    "stream.error": {
        status: number;
        message: string;
    };
};

type Ticket = {
    id: string;
    title: string;
    description: string;
    status: TicketStatus;
    priority: TicketPriority;

    requester: TicketParticipant;
    assignee: TicketParticipant | null;
    updatedBy: TicketParticipant | null;

    createdAt: string;
    updatedAt: string;
};

type TicketPagination = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

type TicketListResponse = {
    data: Ticket[];
    pagination: TicketPagination;
};

const ticketParticipantSelect = {
    id: true,
    name: true,
} satisfies Prisma.UserSelect;

const ticketSelect = {
    id: true,
    title: true,
    description: true,
    status: true,
    priority: true,

    requester: {
        select: ticketParticipantSelect,
    },

    assignee: {
        select: ticketParticipantSelect,
    },

    updatedBy: {
        select: ticketParticipantSelect,
    },

    createdAt: true,
    updatedAt: true,
} satisfies Prisma.TicketSelect;

type TicketRecord = Prisma.TicketGetPayload<{
    select: typeof ticketSelect;
}>;

const toTicketResponse = (
    ticket: TicketRecord
): Ticket => ({
    ...ticket,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
});

const ticketCommentSelect = {
    id: true,
    ticketId: true,
    content: true,

    author: {
        select: ticketParticipantSelect,
    },

    createdAt: true,
} satisfies Prisma.TicketCommentSelect;

type TicketCommentRecord = Prisma.TicketCommentGetPayload<{
    select: typeof ticketCommentSelect;
}>;

const toTicketCommentResponse = (
    comment: TicketCommentRecord
): TicketComment => ({
    ...comment,
    createdAt: comment.createdAt.toISOString(),
});

type TicketAttachment = {
    id: string;
    ticketId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedBy: TicketParticipant;
    createdAt: string;
};

type AttachmentDownload = {
    downloadUrl: string;
    expiresAt: string;
};

const ticketAttachmentSelect = {
    id: true,
    ticketId: true,
    fileName: true,
    mimeType: true,
    sizeBytes: true,

    uploadedBy: {
        select: ticketParticipantSelect,
    },

    createdAt: true,
} satisfies Prisma.TicketAttachmentSelect;

type TicketAttachmentRecord =
    Prisma.TicketAttachmentGetPayload<{
        select: typeof ticketAttachmentSelect;
    }>;

const toTicketAttachmentResponse = (
    attachment: TicketAttachmentRecord
): TicketAttachment => ({
    ...attachment,
    createdAt: attachment.createdAt.toISOString(),
});

export {
    ticketParticipantSelect,
    ticketSelect,
    toTicketResponse,
    ticketCommentSelect,
    toTicketCommentResponse,
    ticketAttachmentSelect,
    toTicketAttachmentResponse,
};

export type {
    TicketActor,
    TicketParticipant,
    Ticket,
    TicketRecord,
    TicketPagination,
    TicketListResponse,
    TicketComment,
    TicketCommentRecord,
    TicketCommentEventMap,
    TicketAttachment,
    TicketAttachmentRecord,
    AttachmentDownload,
};