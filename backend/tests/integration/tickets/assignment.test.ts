import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

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

const assign = (
    ticketId: string,
    token: string,
    assigneeId: string | null
) =>
    api
        .patch(`${endpoint}/${ticketId}/assignment`)
        .set(withAuth(token))
        .send({ assigneeId });

describe("Ticket Assignment", () => {
    setupIntegrationTests();

    it.each([
        "OPEN",
        "IN_PROGRESS",
        "RESOLVED",
    ] as const)(
        "should allow ADMIN assignment changes in %s",
        async (status) => {
            const admin = await createTicketActor("ADMIN");
            const first = await createTicketActor("EMPLOYEE");
            const second = await createTicketActor("EMPLOYEE");
            const requester = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                status,
                assigneeId: first.user.id,
                updatedAt: new Date("2025-01-01"),
            });

            await assign(
                ticket.id,
                admin.accessToken,
                second.user.id
            ).expect(200);

            const reassigned = await getTestTicket(ticket.id);

            expect(reassigned).toMatchObject({
                requesterId: requester.user.id,
                assigneeId: second.user.id,
                updatedById: admin.user.id,
                createdAt: ticket.createdAt,
                status,
            });

            expect(reassigned.updatedAt.getTime())
                .toBeGreaterThan(ticket.updatedAt.getTime());

            await assign(
                ticket.id,
                admin.accessToken,
                null
            ).expect(200);

            expect(await getTestTicket(ticket.id))
                .toMatchObject({
                    assigneeId: null,
                    requesterId: requester.user.id,
                    status,
                });

            await assign(
                ticket.id,
                admin.accessToken,
                first.user.id
            ).expect(200);

            expect(await getTestTicket(ticket.id))
                .toMatchObject({
                    assigneeId: first.user.id,
                    updatedById: admin.user.id,
                    status,
                });
        }
    );

    it("should permit employee self-assignment", async () => {
        const employee = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            updatedAt: new Date("2025-01-01"),
        });

        await assign(
            ticket.id,
            employee.accessToken,
            employee.user.id
        ).expect(200);

        const updated = await getTestTicket(ticket.id);

        expect(updated).toMatchObject({
            requesterId: requester.user.id,
            assigneeId: employee.user.id,
            updatedById: employee.user.id,
            createdAt: ticket.createdAt,
            status: ticket.status,
        });

        expect(updated.updatedAt.getTime())
            .toBeGreaterThan(ticket.updatedAt.getTime());
    });

    it("should reject employee assignment to other users or null", async () => {
        const employee = await createTicketActor("EMPLOYEE");
        const other = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: employee.user.id,
        });

        for (const assigneeId of [other.user.id, null]) {
            await assign(
                ticket.id,
                employee.accessToken,
                assigneeId
            ).expect(403);
        }

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject self-assignment of an already assigned visible ticket", async () => {
        const employee = await createTicketActor("EMPLOYEE");
        const other = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: employee.user.id,
            assigneeId: other.user.id,
        });

        await assign(
            ticket.id,
            employee.accessToken,
            employee.user.id
        ).expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should conceal inaccessible assigned tickets", async () => {
        const employee = await createTicketActor("EMPLOYEE");
        const assignee = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: assignee.user.id,
        });

        await assign(
            ticket.id,
            employee.accessToken,
            employee.user.id
        ).expect(404);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should prohibit USER assignment operations", async () => {
        const user = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: user.user.id,
        });

        await assign(
            ticket.id,
            user.accessToken,
            employee.user.id
        ).expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject nonexistent and ineligible assignees", async () => {
        const admin = await createTicketActor("ADMIN");
        const user = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: user.user.id,
        });

        await assign(
            ticket.id,
            admin.accessToken,
            randomUUID()
        ).expect(404);

        for (const id of [admin.user.id, user.user.id]) {
            await assign(
                ticket.id,
                admin.accessToken,
                id
            ).expect(400);
        }

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject assignment changes on CLOSED tickets", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
            assigneeId: employee.user.id,
            status: "CLOSED",
        });

        await assign(
            ticket.id,
            admin.accessToken,
            null
        ).expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should preserve metadata when ADMIN assigns the existing assignee", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
            assigneeId: employee.user.id,
            updatedById: employee.user.id,
            updatedAt: new Date("2025-01-01"),
        });

        await assign(
            ticket.id,
            admin.accessToken,
            employee.user.id
        ).expect(200);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should allow exactly one concurrent claim by different employees", async () => {
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            updatedAt: new Date("2025-01-01"),
        });

        const responses = await Promise.all([
            assign(
                ticket.id,
                first.accessToken,
                first.user.id
            ),
            assign(
                ticket.id,
                second.accessToken,
                second.user.id
            ),
        ]);

        expect(
            responses.map((response) => response.status).sort()
        ).toEqual([200, 404]);

        const winner = responses[0]?.status === 200
            ? first
            : second;

        const loser = winner.user.id === first.user.id
            ? second
            : first;

        const updated = await getTestTicket(ticket.id);

        expect(updated).toMatchObject({
            requesterId: requester.user.id,
            assigneeId: winner.user.id,
            updatedById: winner.user.id,
            createdAt: ticket.createdAt,
        });

        expect(updated.updatedAt.getTime())
            .toBeGreaterThan(ticket.updatedAt.getTime());

        await api
            .get(`${endpoint}/${ticket.id}`)
            .set(withAuth(loser.accessToken))
            .expect(404);
    });

    it("should reject concurrent duplicate self-assignment", async () => {
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: employee.user.id,
        });

        const responses = await Promise.all([
            assign(
                ticket.id,
                employee.accessToken,
                employee.user.id
            ),
            assign(
                ticket.id,
                employee.accessToken,
                employee.user.id
            ),
        ]);

        expect(
            responses.map((response) => response.status).sort()
        ).toEqual([200, 409]);

        const successful = responses.find(
            (response) => response.status === 200
        );

        const updated = await getTestTicket(ticket.id);

        expect(updated.assigneeId).toBe(employee.user.id);

        expect(updated.updatedAt.toISOString())
            .toBe(successful?.body.data.updatedAt);
    });

    it("should enforce role-specific assignment permissions", async () => {
        const { user } = await createTestUser({
            role: "EMPLOYEE",
            permissions: ["ticket:assign"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await assign(
            ticket.id,
            token,
            user.id
        ).expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should enforce authentication and assignment validation", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .send({ assigneeId: null })
            .expect(401);

        await assign(
            ticket.id,
            admin.accessToken,
            "invalid-id"
        ).expect(400);

        await assign(
            "invalid-id",
            admin.accessToken,
            null
        ).expect(400);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });
});