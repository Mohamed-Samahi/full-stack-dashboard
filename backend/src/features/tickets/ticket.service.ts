import { prisma } from "../../config/db.js";
import { AppError } from "../../errors/AppError.js";

import type {
    Prisma,
} from "../../generated/prisma/client.js";

import {
    PERMISSIONS,
} from "../rbac/rbac.constants.js";

import type {
    PermissionKey,
} from "../rbac/rbac.constants.js";

import {
    lockRbacConfiguration,
} from "../rbac/rbac.lock.js";

import {
    ticketSelect,
    toTicketResponse,
} from "./ticket.types.js";

import type {
    TicketActor,
    Ticket,
    TicketListResponse,
} from "./ticket.types.js";

import type {
    CreateTicketData,
    UpdateTicketData,
    AssignTicketData,
    UpdateTicketStatusData,
} from "./ticket.schema.js";

import {
    assertSupportedRole,
    getTicketVisibilityWhere,
    assertTicketUpdateAllowed,
    getAssignmentPermission,
    assertTicketAssignmentAllowed,
    assertTicketTransitionAllowed,
} from "./ticket.authorization.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const TICKET_TRANSACTION_OPTIONS = {
    isolationLevel: "ReadCommitted",
    maxWait: 10000,
    timeout: 15000,
} as const;

// Shared transaction mechanism for ticket mutations and
// future comment and attachment persistence.
const withTicketTransaction = async <T>(
    operation: (
        tx: Prisma.TransactionClient
    ) => Promise<T>
): Promise<T> => {
    return prisma.$transaction(
        async (tx) => {
            await lockRbacConfiguration(tx);

            return operation(tx);
        },
        TICKET_TRANSACTION_OPTIONS
    );
};

// Revalidate operation-level authorization after
// acquiring the shared transaction lock.
const assertCurrentTicketActor = async (
    tx: Prisma.TransactionClient,
    actor: TicketActor,
    permission: PermissionKey
): Promise<void> => {
    const currentUser = await tx.user.findUnique({
        where: {
            id: actor.id,
        },
        select: {
            role: {
                select: {
                    name: true,
                    permissions: {
                        where: {
                            permission: {
                                key: permission,
                            },
                        },
                        select: {
                            permissionId: true,
                        },
                    },
                },
            },
        },
    });

    if (
        !currentUser ||
        currentUser.role.name !== actor.role
    ) {
        throw new AppError(
            "Invalid or revoked authentication",
            401
        );
    }

    assertSupportedRole(actor);

    if (
        !actor.permissions.includes(permission) ||
        currentUser.role.permissions.length === 0
    ) {
        throw new AppError("Forbidden", 403);
    }
};

// Lock order:
// 1. Shared RBAC configuration lock.
// 2. Parent ticket row lock.
// 3. Resource authorization and business validation.
// 4. Mutation and commit.
const getLockedVisibleTicket = async (
    tx: Prisma.TransactionClient,
    actor: TicketActor,
    ticketId: string
) => {
    const visibility = getTicketVisibilityWhere(actor);

    const where: Prisma.TicketWhereInput = {
        AND: [
            { id: ticketId },
            visibility,
        ],
    };

    const visibleTicket = await tx.ticket.findFirst({
        where,
        select: {
            id: true,
        },
    });

    if (!visibleTicket) {
        throw new AppError("Ticket not found", 404);
    }

    const lockedRows = await tx.$queryRaw<
        { id: string }[]
    >`
        SELECT "id"
        FROM "Ticket"
        WHERE "id" = ${ticketId}
        FOR UPDATE
    `;

    if (lockedRows.length === 0) {
        throw new AppError("Ticket not found", 404);
    }

    const ticket = await tx.ticket.findFirst({
        where,
    });

    if (!ticket) {
        throw new AppError("Ticket not found", 404);
    }

    return ticket;
};

const getTicketResponse = async (
    tx: Prisma.TransactionClient,
    ticketId: string
): Promise<Ticket> => {
    const ticket = await tx.ticket.findUniqueOrThrow({
        where: {
            id: ticketId,
        },
        select: ticketSelect,
    });

    return toTicketResponse(ticket);
};

const createTicket = async (
    actor: TicketActor,
    data: CreateTicketData
): Promise<Ticket> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_CREATE
        );

        const ticket = await tx.ticket.create({
            data: {
                title: data.title,
                description: data.description,
                requesterId: actor.id,
            },
            select: ticketSelect,
        });

        return toTicketResponse(ticket);
    });
};

const getTickets = async (
    actor: TicketActor
): Promise<TicketListResponse> => {
    const where = getTicketVisibilityWhere(actor);

    const page = DEFAULT_PAGE;
    const limit = DEFAULT_LIMIT;

    const [total, tickets] = await prisma.$transaction(
        [
            prisma.ticket.count({
                where,
            }),

            prisma.ticket.findMany({
                where,
                select: ticketSelect,
                orderBy: [
                    { createdAt: "desc" },
                    { id: "desc" },
                ],
                skip: (page - 1) * limit,
                take: limit,
            }),
        ],
        {
            isolationLevel: "RepeatableRead",
        }
    );

    return {
        data: tickets.map(toTicketResponse),

        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
};

const getTicketById = async (
    actor: TicketActor,
    ticketId: string
): Promise<Ticket> => {
    const ticket = await prisma.ticket.findFirst({
        where: {
            AND: [
                { id: ticketId },
                getTicketVisibilityWhere(actor),
            ],
        },
        select: ticketSelect,
    });

    if (!ticket) {
        throw new AppError("Ticket not found", 404);
    }

    return toTicketResponse(ticket);
};

const updateTicket = async (
    actor: TicketActor,
    ticketId: string,
    data: UpdateTicketData
): Promise<Ticket> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_UPDATE
        );

        const ticket = await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        assertTicketUpdateAllowed(
            actor,
            ticket,
            data
        );

        const changes: Prisma.TicketUncheckedUpdateInput =
            {};

        if (
            data.title !== undefined &&
            data.title !== ticket.title
        ) {
            changes.title = data.title;
        }

        if (
            data.description !== undefined &&
            data.description !== ticket.description
        ) {
            changes.description = data.description;
        }

        if (
            data.priority !== undefined &&
            data.priority !== ticket.priority
        ) {
            changes.priority = data.priority;
        }

        if (Object.keys(changes).length === 0) {
            return getTicketResponse(tx, ticketId);
        }

        const updatedTicket = await tx.ticket.update({
            where: {
                id: ticketId,
            },
            data: {
                ...changes,
                updatedById: actor.id,
                updatedAt: new Date(),
            },
            select: ticketSelect,
        });

        return toTicketResponse(updatedTicket);
    });
};

const assignTicket = async (
    actor: TicketActor,
    ticketId: string,
    data: AssignTicketData
): Promise<Ticket> => {
    return withTicketTransaction(async (tx) => {
        const permission = getAssignmentPermission(actor);

        await assertCurrentTicketActor(
            tx,
            actor,
            permission
        );

        const ticket = await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        const { assigneeId } = data;

        assertTicketAssignmentAllowed(
            actor,
            ticket,
            assigneeId
        );

        if (assigneeId !== null) {
            const assignee = await tx.user.findUnique({
                where: {
                    id: assigneeId,
                },
                select: {
                    role: {
                        select: {
                            name: true,
                        },
                    },
                },
            });

            if (!assignee) {
                throw new AppError(
                    "Assignee not found",
                    404
                );
            }

            if (assignee.role.name !== "EMPLOYEE") {
                throw new AppError(
                    "Tickets can only be assigned to employees",
                    400
                );
            }
        }

        if (ticket.assigneeId === assigneeId) {
            return getTicketResponse(tx, ticketId);
        }

        const updatedTicket = await tx.ticket.update({
            where: {
                id: ticketId,
            },
            data: {
                assigneeId,
                updatedById: actor.id,
                updatedAt: new Date(),
            },
            select: ticketSelect,
        });

        return toTicketResponse(updatedTicket);
    });
};

const updateTicketStatus = async (
    actor: TicketActor,
    ticketId: string,
    data: UpdateTicketStatusData
): Promise<Ticket> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_TRANSITION
        );

        const ticket = await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        assertTicketTransitionAllowed(
            actor,
            ticket,
            data.status
        );

        const updatedTicket = await tx.ticket.update({
            where: {
                id: ticketId,
            },
            data: {
                status: data.status,
                updatedById: actor.id,
                updatedAt: new Date(),
            },
            select: ticketSelect,
        });

        return toTicketResponse(updatedTicket);
    });
};

export {
    createTicket,
    getTickets,
    getTicketById,
    updateTicket,
    assignTicket,
    updateTicketStatus,

    // Shared with subsequent ticket features.
    withTicketTransaction,
    assertCurrentTicketActor,
    getLockedVisibleTicket,
};