import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    createTestTicket,
    getTestTicket,
} from "../../factories/ticket.factory.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

describe("Ticket Database Constraints", () => {
    setupIntegrationTests();

    it("should enforce ticket defaults at persistence level", async () => {
        const { user } = await createTestUser();

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        expect(ticket).toMatchObject({
            requesterId: user.id,
            status: "OPEN",
            priority: "MEDIUM",
            assigneeId: null,
            updatedById: null,
        });

        expect(ticket.createdAt).toBeInstanceOf(Date);
        expect(ticket.updatedAt).toBeInstanceOf(Date);
    });

    it.each([
        { title: "", description: "Valid description" },
        { title: "   ", description: "Valid description" },
        { title: "\t\n", description: "Valid description" },
        { title: "Valid title", description: "" },
        { title: "Valid title", description: "   " },
        { title: "Valid title", description: "\t\n" },
    ])("should enforce nonempty title and description constraints", async (payload) => {
        const { user } = await createTestUser();

        await expect(
            prisma.$executeRaw`
                INSERT INTO "Ticket" (
                    "id",
                    "title",
                    "description",
                    "requesterId",
                    "updatedAt"
                )
                VALUES (
                    ${randomUUID()},
                    ${payload.title},
                    ${payload.description},
                    ${user.id},
                    CURRENT_TIMESTAMP
                )
            `
        ).rejects.toMatchObject({
            code: "P2010",
            meta: {
                driverAdapterError: {
                    cause: {
                        originalCode: "23514",
                    },
                },
            },
        });

        expect(await prisma.ticket.count()).toBe(0);
    });

    it("should enforce maximum title length", async () => {
        const { user } = await createTestUser();

        await expect(
            prisma.$executeRaw`
                INSERT INTO "Ticket" (
                    "id",
                    "title",
                    "description",
                    "requesterId",
                    "updatedAt"
                )
                VALUES (
                    ${randomUUID()},
                    ${"a".repeat(201)},
                    ${"Valid description"},
                    ${user.id},
                    CURRENT_TIMESTAMP
                )
            `
        ).rejects.toMatchObject({
            code: "P2010",
            meta: {
                driverAdapterError: {
                    cause: {
                        originalCode: "22001",
                    },
                },
            },
        });

        expect(await prisma.ticket.count()).toBe(0);
    });

    it.each([
        "requesterId",
        "assigneeId",
        "updatedById",
    ] as const)(
        "should enforce the %s foreign key",
        async (field) => {
            const { user } = await createTestUser();

            await expect(
                createTestTicket({
                    requesterId: user.id,
                    [field]: randomUUID(),
                })
            ).rejects.toMatchObject({
                code: "P2003",
            });

            expect(await prisma.ticket.count()).toBe(0);
        }
    );

    it.each([
        "requesterId",
        "assigneeId",
        "updatedById",
    ] as const)(
        "should restrict deletion of users referenced by %s",
        async (field) => {
            const { user: requester } =
                await createTestUser();

            const { user: referencedUser } =
                await createTestUser({
                    role: "EMPLOYEE",
                });

            const ticket = await createTestTicket({
                requesterId: requester.id,
                [field]: referencedUser.id,
            });

            await expect(
                prisma.user.delete({
                    where: {
                        id: referencedUser.id,
                    },
                })
            ).rejects.toMatchObject({
                code: "P2003",
            });

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);

            expect(await prisma.user.findUnique({
                where: {
                    id: referencedUser.id,
                },
            })).not.toBeNull();
        }
    );

    it("should enforce valid database enum values", async () => {
        const { user } = await createTestUser();

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await expect(
            prisma.$executeRaw`
                UPDATE "Ticket"
                SET "status" = 'INVALID'::"TicketStatus"
                WHERE "id" = ${ticket.id}
            `
        ).rejects.toMatchObject({
            code: "P2010",
            meta: {
                driverAdapterError: {
                    cause: {
                        originalCode: "22P02",
                    },
                },
            },
        });

        await expect(
            prisma.$executeRaw`
                UPDATE "Ticket"
                SET "priority" = 'INVALID'::"TicketPriority"
                WHERE "id" = ${ticket.id}
            `
        ).rejects.toMatchObject({
            code: "P2010",
            meta: {
                driverAdapterError: {
                    cause: {
                        originalCode: "22P02",
                    },
                },
            },
        });

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should contain the approved composite indexes without redundant indexes", async () => {
        const indexes = await prisma.$queryRaw<
            { indexname: string }[]
        >`
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'Ticket'
        `;

        const names = indexes.map(
            ({ indexname }) => indexname
        );

        expect(names).toEqual(
            expect.arrayContaining([
                "Ticket_pkey",
                "Ticket_requesterId_createdAt_idx",
                "Ticket_assigneeId_status_createdAt_idx",
                "Ticket_createdAt_id_idx",
            ])
        );

        expect(names)
            .not.toContain("Ticket_requesterId_idx");

        expect(names)
            .not.toContain("Ticket_assigneeId_idx");
    });
});