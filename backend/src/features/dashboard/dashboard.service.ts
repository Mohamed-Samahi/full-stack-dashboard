import { prisma } from "../../config/db.js";

import {
    TicketStatus,
} from "../../generated/prisma/enums.js";

import {
    getTicketVisibilityWhere,
} from "../tickets/ticket.authorization.js";

import type {
    TicketActor,
} from "../tickets/ticket.types.js";

type DashboardStats = {
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
    closed: number;
};

const getDashboardStats = async (
    actor: TicketActor
): Promise<DashboardStats> => {
    const groups = await prisma.ticket.groupBy({
        by: ["status"],

        where: getTicketVisibilityWhere(actor),

        _count: {
            _all: true,
        },
    });

    const counts: Record<TicketStatus, number> = {
        [TicketStatus.OPEN]: 0,
        [TicketStatus.IN_PROGRESS]: 0,
        [TicketStatus.RESOLVED]: 0,
        [TicketStatus.CLOSED]: 0,
    };

    for (const group of groups) {
        counts[group.status] = group._count._all;
    }

    return {
        total:
            counts.OPEN +
            counts.IN_PROGRESS +
            counts.RESOLVED +
            counts.CLOSED,

        open: counts.OPEN,
        inProgress: counts.IN_PROGRESS,
        resolved: counts.RESOLVED,
        closed: counts.CLOSED,
    };
};

export { getDashboardStats };

export type { DashboardStats };