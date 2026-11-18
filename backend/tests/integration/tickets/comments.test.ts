import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    createTicketActor,
    createTestTicket,
    getTestTicket,
} from "../../factories/ticket.factory.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    createTestAccessToken,
    withAuth,
} from "../../helpers/auth.helper.js";

import { api } from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/tickets";

const commentsEndpoint = (ticketId: string) =>
    `${endpoint}/${ticketId}/comments`;

const createComment = (
    ticketId: string,
    token: string,
    content = "Test comment"
) =>
    api
        .post(commentsEndpoint(ticketId))
        .set(withAuth(token))
        .send({ content });

const getComments = (
    ticketId: string,
    token: string
) =>
    api
        .get(commentsEndpoint(ticketId))
        .set(withAuth(token));

const countComments = (ticketId: string) =>
    prisma.ticketComment.count({
        where: { ticketId },
    });

describe("Ticket Comments", () => {
    setupIntegrationTests();

    const creationCases = (
        ["ADMIN", "EMPLOYEE", "USER"] as const
    ).flatMap((role) =>
        (
            ["OPEN", "IN_PROGRESS", "RESOLVED"] as const
        ).map((status) => ({
            role,
            status,
        }))
    );

    it.each(creationCases)(
        "should allow $role to comment on accessible $status tickets",
        async ({ role, status }) => {
            const actor = await createTicketActor(role);
            const employee = await createTicketActor("EMPLOYEE");

            const requester = role === "USER"
                ? actor
                : await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,

                assigneeId: role === "EMPLOYEE"
                    ? actor.user.id
                    : employee.user.id,

                status,
                updatedById: employee.user.id,
                updatedAt: new Date("2025-01-01"),
            });

            const response = await createComment(
                ticket.id,
                actor.accessToken,
                "  Valid comment  "
            ).expect(201);

            const saved = await prisma.ticketComment.findUniqueOrThrow({
                where: {
                    id: response.body.data.id,
                },
            });

            expect(saved).toMatchObject({
                ticketId: ticket.id,
                authorId: actor.user.id,
                content: "Valid comment",
            });

            expect(response.body).toEqual({
                data: {
                    id: saved.id,
                    ticketId: ticket.id,
                    content: "Valid comment",
                    author: {
                        id: actor.user.id,
                        name: actor.user.name,
                    },
                    createdAt: saved.createdAt.toISOString(),
                },
            });

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);

            expect(await countComments(ticket.id))
                .toBe(1);
        }
    );

    it("should permit employees to comment on unassigned tickets", async () => {
        const employee = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
        });

        await createComment(
            ticket.id,
            employee.accessToken
        ).expect(201);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it.each(["ADMIN", "EMPLOYEE", "USER"] as const)(
        "should allow %s to read CLOSED tickets but reject comment creation",
        async (role) => {
            const actor = await createTicketActor(role);

            const ticket = await createTestTicket({
                requesterId: actor.user.id,
                status: "CLOSED",
                updatedAt: new Date("2025-01-01"),
                updatedById: actor.user.id,
            });

            const existing = await prisma.ticketComment.create({
                data: {
                    ticketId: ticket.id,
                    authorId: actor.user.id,
                    content: "Historical comment",
                },
            });

            const response = await getComments(
                ticket.id,
                actor.accessToken
            ).expect(200);

            expect(response.body.data).toHaveLength(1);
            expect(response.body.data[0].id).toBe(existing.id);

            await createComment(
                ticket.id,
                actor.accessToken
            ).expect(409);

            expect(await countComments(ticket.id))
                .toBe(1);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should return an empty conversation", async () => {
        const actor = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: actor.user.id,
        });

        const response = await getComments(
            ticket.id,
            actor.accessToken
        ).expect(200);

        expect(response.body).toEqual({
            data: [],
        });
    });

    it("should return only ticket comments in deterministic chronological order", async () => {
        const actor = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: actor.user.id,
        });

        const otherTicket = await createTestTicket({
            requesterId: actor.user.id,
        });

        const firstId =
            "00000000-0000-4000-8000-000000000001";

        const secondId =
            "00000000-0000-4000-8000-000000000002";

        const thirdId =
            "00000000-0000-4000-8000-000000000003";

        const createdAt = new Date("2025-01-01");

        await prisma.ticketComment.createMany({
            data: [
                {
                    id: thirdId,
                    ticketId: ticket.id,
                    authorId: actor.user.id,
                    content: "Third",
                    createdAt: new Date("2025-01-02"),
                },
                {
                    id: secondId,
                    ticketId: ticket.id,
                    authorId: actor.user.id,
                    content: "Second",
                    createdAt,
                },
                {
                    id: firstId,
                    ticketId: ticket.id,
                    authorId: actor.user.id,
                    content: "First",
                    createdAt,
                },
                {
                    ticketId: otherTicket.id,
                    authorId: actor.user.id,
                    content: "Other conversation",
                    createdAt,
                },
            ],
        });

        const response = await getComments(
            ticket.id,
            actor.accessToken
        ).expect(200);

        expect(
            response.body.data.map(
                (comment: { id: string }) => comment.id
            )
        ).toEqual([
            firstId,
            secondId,
            thirdId,
        ]);

        expect(response.body.data[0]).toEqual({
            id: firstId,
            ticketId: ticket.id,
            content: "First",
            author: {
                id: actor.user.id,
                name: actor.user.name,
            },
            createdAt: createdAt.toISOString(),
        });

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should require authentication for comment operations", async () => {
        const actor = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: actor.user.id,
        });

        await api
            .get(commentsEndpoint(ticket.id))
            .expect(401);

        await api
            .post(commentsEndpoint(ticket.id))
            .send({ content: "Unauthorized" })
            .expect(401);

        expect(await countComments(ticket.id))
            .toBe(0);
    });

    it("should enforce operation-specific permissions", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:read"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await getComments(
            ticket.id,
            token
        ).expect(200);

        await createComment(
            ticket.id,
            token
        ).expect(403);

        expect(await countComments(ticket.id))
            .toBe(0);
    });

    it("should require ticket:read for comment retrieval", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:comment"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await getComments(
            ticket.id,
            token
        ).expect(403);
    });

    it("should reject unsupported roles even with ticket permissions", async () => {
        const { user } = await createTestUser({
            role: "CUSTOM",
            permissions: [
                "ticket:read",
                "ticket:comment",
            ],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await getComments(ticket.id, token)
            .expect(403);

        await createComment(ticket.id, token)
            .expect(403);
    });

    it("should conceal inaccessible and nonexistent parent tickets", async () => {
        const owner = await createTicketActor("USER");
        const other = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");
        const assignee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: assignee.user.id,
        });

        for (const actor of [other, employee]) {
            await getComments(
                ticket.id,
                actor.accessToken
            ).expect(404);

            await createComment(
                ticket.id,
                actor.accessToken
            ).expect(404);
        }

        const missingId = randomUUID();

        await getComments(
            missingId,
            owner.accessToken
        ).expect(404);

        await createComment(
            missingId,
            owner.accessToken
        ).expect(404);

        expect(await countComments(ticket.id))
            .toBe(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should validate identifiers and reject unsupported payload fields", async () => {
        const actor = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: actor.user.id,
        });

        await getComments(
            "invalid-id",
            actor.accessToken
        ).expect(400);

        await createComment(
            "invalid-id",
            actor.accessToken
        ).expect(400);

        for (const body of [
            {},
            { content: " " },
            { content: "a".repeat(5001) },
            {
                content: "Valid",
                authorId: randomUUID(),
            },
        ]) {
            await api
                .post(commentsEndpoint(ticket.id))
                .set(withAuth(actor.accessToken))
                .send(body)
                .expect(400);
        }

        expect(await countComments(ticket.id))
            .toBe(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should remove assignment-based conversation access after reassignment", async () => {
        const admin = await createTicketActor("ADMIN");
        const owner = await createTicketActor("USER");
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: first.user.id,
        });

        const comment = await createComment(
            ticket.id,
            first.accessToken
        ).expect(201);

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .set(withAuth(admin.accessToken))
            .send({ assigneeId: second.user.id })
            .expect(200);

        await getComments(
            ticket.id,
            first.accessToken
        ).expect(404);

        await createComment(
            ticket.id,
            first.accessToken
        ).expect(404);

        const response = await getComments(
            ticket.id,
            second.accessToken
        ).expect(200);

        expect(response.body.data).toEqual([
            comment.body.data,
        ]);
    });

    it("should retain requester access after losing assignment", async () => {
        const admin = await createTicketActor("ADMIN");
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: first.user.id,
            assigneeId: first.user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .set(withAuth(admin.accessToken))
            .send({ assigneeId: second.user.id })
            .expect(200);

        await createComment(
            ticket.id,
            first.accessToken
        ).expect(201);

        await getComments(
            ticket.id,
            first.accessToken
        ).expect(200);
    });

    it("should preserve authorship after a user role change", async () => {
        const admin = await createTicketActor("ADMIN");
        const author = await createTicketActor("EMPLOYEE");
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const comment = await createComment(
            ticket.id,
            author.accessToken
        ).expect(201);

        await api
            .patch(`/api/v1/rbac/users/${author.user.id}/role`)
            .set(withAuth(admin.accessToken))
            .send({
                roleId: owner.user.roleId,
            })
            .expect(200);

        const response = await getComments(
            ticket.id,
            owner.accessToken
        ).expect(200);

        expect(response.body.data).toEqual([
            comment.body.data,
        ]);

        expect(await prisma.ticketComment.findUniqueOrThrow({
            where: {
                id: comment.body.data.id,
            },
        })).toMatchObject({
            authorId: author.user.id,
        });

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should serialize concurrent closure and comment creation", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            status: "RESOLVED",
        });

        const [closure, comment] = await Promise.all([
            api
                .patch(`${endpoint}/${ticket.id}/status`)
                .set(withAuth(owner.accessToken))
                .send({ status: "CLOSED" }),

            createComment(
                ticket.id,
                owner.accessToken
            ),
        ]);

        expect(closure.status).toBe(200);
        expect([201, 409]).toContain(comment.status);

        const closed = await getTestTicket(ticket.id);

        expect(closed.status).toBe("CLOSED");

        expect(closed.updatedById)
            .toBe(owner.user.id);

        expect(closed.updatedAt.toISOString())
            .toBe(closure.body.data.updatedAt);

        expect(await countComments(ticket.id))
            .toBe(comment.status === 201 ? 1 : 0);

        await createComment(
            ticket.id,
            owner.accessToken
        ).expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(closed);
    });

    it("should serialize reassignment and concurrent comment creation", async () => {
        const admin = await createTicketActor("ADMIN");
        const owner = await createTicketActor("USER");
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: first.user.id,
        });

        const [assignment, comment] = await Promise.all([
            api
                .patch(`${endpoint}/${ticket.id}/assignment`)
                .set(withAuth(admin.accessToken))
                .send({
                    assigneeId: second.user.id,
                }),

            createComment(
                ticket.id,
                first.accessToken
            ),
        ]);

        expect(assignment.status).toBe(200);
        expect([201, 404]).toContain(comment.status);

        const updated = await getTestTicket(ticket.id);

        expect(updated.assigneeId)
            .toBe(second.user.id);

        expect(updated.updatedById)
            .toBe(admin.user.id);

        expect(updated.updatedAt.toISOString())
            .toBe(assignment.body.data.updatedAt);

        expect(await countComments(ticket.id))
            .toBe(comment.status === 201 ? 1 : 0);

        await createComment(
            ticket.id,
            first.accessToken
        ).expect(404);

        expect(await getTestTicket(ticket.id))
            .toEqual(updated);
    });

    it.each(["", " ", "\t\n"])(
        "should enforce nonempty content at database level",
        async (content) => {
            const owner = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: owner.user.id,
            });

            await expect(
                prisma.$executeRaw`
                    INSERT INTO "TicketComment" (
                        "id",
                        "ticketId",
                        "authorId",
                        "content"
                    )
                    VALUES (
                        ${randomUUID()},
                        ${ticket.id},
                        ${owner.user.id},
                        ${content}
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

            expect(await countComments(ticket.id))
                .toBe(0);
        }
    );

    it("should restrict deletion of referenced tickets and authors", async () => {
        const owner = await createTicketActor("USER");
        const author = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        await createComment(
            ticket.id,
            author.accessToken
        ).expect(201);

        await expect(
            prisma.ticket.delete({
                where: { id: ticket.id },
            })
        ).rejects.toMatchObject({
            code: "P2003",
        });

        await expect(
            prisma.user.delete({
                where: { id: author.user.id },
            })
        ).rejects.toMatchObject({
            code: "P2003",
        });

        expect(await countComments(ticket.id))
            .toBe(1);
    });
});