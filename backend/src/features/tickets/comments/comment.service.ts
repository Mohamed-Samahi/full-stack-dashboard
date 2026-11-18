import type {
    Prisma,
} from "../../../generated/prisma/client.js";

import {
    PERMISSIONS,
} from "../../rbac/rbac.constants.js";

import {
    assertTicketNotClosed,
} from "../ticket.authorization.js";

import {
    withTicketTransaction,
    assertCurrentTicketActor,
    getLockedVisibleTicket,
} from "../ticket.service.js";

import {
    ticketCommentSelect,
    toTicketCommentResponse,
} from "../ticket.types.js";

import type {
    TicketActor,
    TicketComment,
} from "../ticket.types.js";

import type {
    CreateCommentData,
} from "./comment.schema.js";

const listTicketComments = async (
    tx: Prisma.TransactionClient,
    ticketId: string
): Promise<TicketComment[]> => {
    const comments = await tx.ticketComment.findMany({
        where: {
            ticketId,
        },

        select: ticketCommentSelect,

        orderBy: [
            { createdAt: "asc" },
            { id: "asc" },
        ],
    });

    return comments.map(toTicketCommentResponse);
};

const getComments = async (
    actor: TicketActor,
    ticketId: string
): Promise<TicketComment[]> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_READ
        );

        await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        return listTicketComments(tx, ticketId);
    });
};

const createComment = async (
    actor: TicketActor,
    ticketId: string,
    data: CreateCommentData
): Promise<TicketComment> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_COMMENT
        );

        const ticket = await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        assertTicketNotClosed(ticket);

        const comment = await tx.ticketComment.create({
            data: {
                ticketId: ticket.id,
                authorId: actor.id,
                content: data.content,
            },

            select: ticketCommentSelect,
        });

        return toTicketCommentResponse(comment);
    });
};

export {
    listTicketComments,
    getComments,
    createComment,
};