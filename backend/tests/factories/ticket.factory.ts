import { prisma } from "../../src/config/db.js";

import type {
    Prisma,
} from "../../src/generated/prisma/client.js";

import {
    ROLE_PERMISSIONS,
} from "../../src/features/rbac/rbac.constants.js";

import type {
    PredefinedRole,
} from "../../src/features/rbac/rbac.constants.js";

import {
    createTestUser,
} from "./user.factory.js";

import {
    createTestAccessToken,
} from "../helpers/auth.helper.js";

type CreateTicketOptions = Omit<
    Prisma.TicketUncheckedCreateInput,
    "title" | "description"
> & {
    title?: string;
    description?: string;
};

export async function createTestTicket(
    options: CreateTicketOptions
) {
    return prisma.ticket.create({
        data: {
            title: "Test ticket",
            description: "Test ticket description",
            ...options,
        },
    });
}

export async function createTicketActor(
    role: PredefinedRole
) {
    const { user } = await createTestUser({
        role,
        permissions: [...ROLE_PERMISSIONS[role]],
        hashPassword: false,
    });

    const accessToken = await createTestAccessToken(
        user.id
    );

    return {
        user,
        accessToken,
    };
}

export function getTestTicket(id: string) {
    return prisma.ticket.findUniqueOrThrow({
        where: { id },
    });
}