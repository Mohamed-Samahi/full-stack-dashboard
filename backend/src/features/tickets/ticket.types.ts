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

export {
    ticketParticipantSelect,
    ticketSelect,
    toTicketResponse,
};

export type {
    TicketActor,
    TicketParticipant,
    Ticket,
    TicketRecord,
    TicketPagination,
    TicketListResponse,
};