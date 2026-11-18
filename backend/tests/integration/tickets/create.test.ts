import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    createTicketActor,
    getTestTicket,
} from "../../factories/ticket.factory.js";

import { api } from "../../helpers/api.helper.js";

import {
    createTestAccessToken,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/tickets";

const payload = {
    title: "Application issue",
    description: "Unable to access the application",
};

describe("Ticket Creation", () => {
    setupIntegrationTests();

    it.each([
        "ADMIN",
        "EMPLOYEE",
        "USER",
    ] as const)(
        "should allow %s to create tickets with system defaults",
        async (role) => {
            const actor = await createTicketActor(role);

            const response = await api
                .post(endpoint)
                .set(withAuth(actor.accessToken))
                .send(payload)
                .expect(201);

            const ticket = await getTestTicket(
                response.body.data.id
            );

            expect(ticket).toMatchObject({
                ...payload,
                requesterId: actor.user.id,
                assigneeId: null,
                updatedById: null,
                status: "OPEN",
                priority: "MEDIUM",
            });

            expect(response.body.data).toEqual({
                id: ticket.id,
                ...payload,
                status: "OPEN",
                priority: "MEDIUM",
                requester: {
                    id: actor.user.id,
                    name: actor.user.name,
                },
                assignee: null,
                updatedBy: null,
                createdAt: ticket.createdAt.toISOString(),
                updatedAt: ticket.updatedAt.toISOString(),
            });

            expect(await prisma.ticket.count()).toBe(1);
        }
    );

    it("should persist trimmed ticket content", async () => {
        const actor = await createTicketActor("USER");

        const response = await api
            .post(endpoint)
            .set(withAuth(actor.accessToken))
            .send({
                title: "  Application issue  ",
                description: "  Unable to access the application  ",
            })
            .expect(201);

        expect(await getTestTicket(response.body.data.id))
            .toMatchObject(payload);
    });

    it("should reject unauthenticated creation", async () => {
        await api
            .post(endpoint)
            .send(payload)
            .expect(401);

        expect(await prisma.ticket.count()).toBe(0);
    });

    it("should reject missing creation permissions", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:read"],
        });

        const token = await createTestAccessToken(user.id);

        await api
            .post(endpoint)
            .set(withAuth(token))
            .send(payload)
            .expect(403);

        expect(await prisma.ticket.count()).toBe(0);
    });

    it("should reject unsupported roles even with ticket permissions", async () => {
        const { user } = await createTestUser({
            role: "CUSTOM",
            permissions: [
                "ticket:create",
                "ticket:read",
            ],
        });

        const token = await createTestAccessToken(user.id);

        await api
            .post(endpoint)
            .set(withAuth(token))
            .send(payload)
            .expect(403);

        await api
            .get(endpoint)
            .set(withAuth(token))
            .expect(403);

        expect(await prisma.ticket.count()).toBe(0);
    });

    it.each([
        { requesterId: randomUUID() },
        { assigneeId: randomUUID() },
        { updatedById: randomUUID() },
        { status: "CLOSED" },
        { priority: "HIGH" },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { title: "   " },
        { description: "" },
    ])("should reject unauthorized or invalid creation fields", async (fields) => {
        const actor = await createTicketActor("USER");

        await api
            .post(endpoint)
            .set(withAuth(actor.accessToken))
            .send({
                ...payload,
                ...fields,
            })
            .expect(400);

        expect(await prisma.ticket.count()).toBe(0);
    });
});