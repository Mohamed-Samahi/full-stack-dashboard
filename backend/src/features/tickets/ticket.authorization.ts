import type { Prisma } from "../../generated/prisma/client.js";

import {
    TicketStatus,
} from "../../generated/prisma/enums.js";

import { AppError } from "../../errors/AppError.js";

import {
    isPredefinedRole,
    PERMISSIONS,
} from "../rbac/rbac.constants.js";

import type {
    PermissionKey,
} from "../rbac/rbac.constants.js";

import type {
    TicketActor,
} from "./ticket.types.js";

import type {
    UpdateTicketData,
} from "./ticket.schema.js";

type TicketResource = {
    requesterId: string;
    assigneeId: string | null;
    status: TicketStatus;
};

const assertSupportedRole = (
    actor: TicketActor
): void => {
    if (!isPredefinedRole(actor.role)) {
        throw new AppError("Forbidden", 403);
    }
};

const getTicketVisibilityWhere = (
    actor: TicketActor
): Prisma.TicketWhereInput => {
    assertSupportedRole(actor);

    switch (actor.role) {
        case "ADMIN":
            return {};

        case "EMPLOYEE":
            return {
                OR: [
                    { assigneeId: null },
                    { assigneeId: actor.id },
                    { requesterId: actor.id },
                ],
            };

        case "USER":
            return {
                requesterId: actor.id,
            };

        default:
            throw new AppError("Forbidden", 403);
    }
};

const isRequester = (
    actor: TicketActor,
    ticket: TicketResource
): boolean => {
    return ticket.requesterId === actor.id;
};

const isAssignedEmployee = (
    actor: TicketActor,
    ticket: TicketResource
): boolean => {
    return (
        actor.role === "EMPLOYEE" &&
        ticket.assigneeId === actor.id
    );
};

const hasAgentAccess = (
    actor: TicketActor,
    ticket: TicketResource
): boolean => {
    return (
        actor.role === "ADMIN" ||
        isAssignedEmployee(actor, ticket)
    );
};

const assertTicketNotClosed = (
    ticket: TicketResource
): void => {
    if (ticket.status === TicketStatus.CLOSED) {
        throw new AppError(
            "Closed tickets cannot be modified",
            409
        );
    }
};

const assertTicketUpdateAllowed = (
    actor: TicketActor,
    ticket: TicketResource,
    data: UpdateTicketData
): void => {
    assertSupportedRole(actor);

    const agentAccess = hasAgentAccess(actor, ticket);
    const requesterAccess = isRequester(actor, ticket);

    if (!agentAccess && !requesterAccess) {
        throw new AppError("Forbidden", 403);
    }

    assertTicketNotClosed(ticket);

    if (
        data.priority !== undefined &&
        !agentAccess
    ) {
        throw new AppError(
            "You cannot modify ticket priority",
            403
        );
    }

    if (ticket.status === TicketStatus.RESOLVED) {
        throw new AppError(
            "Resolved tickets must be reopened before editing",
            409
        );
    }

    if (
        !agentAccess &&
        ticket.status !== TicketStatus.OPEN
    ) {
        throw new AppError(
            "Requesters can only edit open tickets",
            409
        );
    }
};

const getAssignmentPermission = (
    actor: TicketActor
): PermissionKey => {
    switch (actor.role) {
        case "ADMIN":
            return PERMISSIONS.TICKET_ASSIGN;

        case "EMPLOYEE":
            return PERMISSIONS.TICKET_SELF_ASSIGN;

        default:
            throw new AppError("Forbidden", 403);
    }
};

const assertTicketAssignmentAllowed = (
    actor: TicketActor,
    ticket: TicketResource,
    assigneeId: string | null
): void => {
    assertSupportedRole(actor);

    if (actor.role === "ADMIN") {
        assertTicketNotClosed(ticket);
        return;
    }

    if (
        actor.role !== "EMPLOYEE" ||
        assigneeId !== actor.id
    ) {
        throw new AppError("Forbidden", 403);
    }

    assertTicketNotClosed(ticket);

    if (ticket.assigneeId !== null) {
        throw new AppError(
            "Ticket is already assigned",
            409
        );
    }
};

const ALLOWED_TRANSITIONS = {
    OPEN: [
        TicketStatus.IN_PROGRESS,
    ],

    IN_PROGRESS: [
        TicketStatus.RESOLVED,
    ],

    RESOLVED: [
        TicketStatus.OPEN,
        TicketStatus.CLOSED,
    ],

    CLOSED: [],
} satisfies Record<
    TicketStatus,
    readonly TicketStatus[]
>;

const assertTicketTransitionAllowed = (
    actor: TicketActor,
    ticket: TicketResource,
    nextStatus: TicketStatus
): void => {
    assertSupportedRole(actor);

    const agentAccess = hasAgentAccess(actor, ticket);
    const requesterAccess = isRequester(actor, ticket);

    if (!agentAccess && !requesterAccess) {
        throw new AppError("Forbidden", 403);
    }

    assertTicketNotClosed(ticket);

    const allowedTransitions: readonly TicketStatus[] =
        ALLOWED_TRANSITIONS[ticket.status];

    if (!allowedTransitions.includes(nextStatus)) {
        throw new AppError(
            "Invalid ticket status transition",
            409
        );
    }

    const requesterTransition =
        ticket.status === TicketStatus.RESOLVED &&
        (
            nextStatus === TicketStatus.OPEN ||
            nextStatus === TicketStatus.CLOSED
        );

    if (
        !agentAccess &&
        !(requesterAccess && requesterTransition)
    ) {
        throw new AppError("Forbidden", 403);
    }

    if (
        nextStatus === TicketStatus.IN_PROGRESS &&
        ticket.assigneeId === null
    ) {
        throw new AppError(
            "Ticket must be assigned before starting progress",
            409
        );
    }
};

export {
    assertSupportedRole,
    getTicketVisibilityWhere,
    isRequester,
    isAssignedEmployee,
    hasAgentAccess,
    assertTicketNotClosed,
    assertTicketUpdateAllowed,
    getAssignmentPermission,
    assertTicketAssignmentAllowed,
    assertTicketTransitionAllowed,
};