import { describe, expect, it } from "vitest";

import type {
    TicketStatus,
} from "../../../src/generated/prisma/client.js";

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

const transition = (
    ticketId: string,
    token: string,
    status: TicketStatus
) =>
    api
        .patch(`${endpoint}/${ticketId}/status`)
        .set(withAuth(token))
        .send({ status });

const validTransitions = [
    {
        from: "OPEN",
        to: "IN_PROGRESS",
    },
    {
        from: "IN_PROGRESS",
        to: "RESOLVED",
    },
    {
        from: "RESOLVED",
        to: "OPEN",
    },
    {
        from: "RESOLVED",
        to: "CLOSED",
    },
] as const;

const agentCases = (
    ["ADMIN", "EMPLOYEE"] as const
).flatMap((role) =>
    validTransitions.map(({ from, to }) => ({
        role,
        from,
        to,
    }))
);

describe("Ticket Lifecycle", () => {
    setupIntegrationTests();

    it.each(agentCases)(
        "should permit $role transition from $from to $to",
        async ({ role, from, to }) => {
            const actor = await createTicketActor(role);
            const requester = await createTicketActor("USER");

            const employee = role === "EMPLOYEE"
                ? actor
                : await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status: from,
                updatedAt: new Date("2025-01-01"),
            });

            const response = await transition(
                ticket.id,
                actor.accessToken,
                to
            ).expect(200);

            const updated = await getTestTicket(ticket.id);

            expect(updated).toMatchObject({
                id: ticket.id,
                title: ticket.title,
                description: ticket.description,
                priority: ticket.priority,
                status: to,
                requesterId: ticket.requesterId,
                assigneeId: ticket.assigneeId,
                createdAt: ticket.createdAt,
                updatedById: actor.user.id,
            });

            expect(updated.updatedAt.getTime())
                .toBeGreaterThan(ticket.updatedAt.getTime());

            expect(response.body.data.status).toBe(to);

            expect(response.body.data.updatedBy).toEqual({
                id: actor.user.id,
                name: actor.user.name,
            });

            expect(response.body.data.updatedAt)
                .toBe(updated.updatedAt.toISOString());
        }
    );

    const requesterCases = (
        ["USER", "EMPLOYEE"] as const
    ).flatMap((role) =>
        (["OPEN", "CLOSED"] as const).map((status) => ({
            role,
            status,
        }))
    );

    it.each(requesterCases)(
        "should permit $role requester to transition RESOLVED to $status",
        async ({ role, status }) => {
            const requester = await createTicketActor(role);
            const employee = await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status: "RESOLVED",
            });

            await transition(
                ticket.id,
                requester.accessToken,
                status
            ).expect(200);

            expect(await getTestTicket(ticket.id))
                .toMatchObject({
                    id: ticket.id,
                    requesterId: requester.user.id,
                    assigneeId: employee.user.id,
                    status,
                    updatedById: requester.user.id,
                    createdAt: ticket.createdAt,
                });
        }
    );

    it("should require assignment before starting progress", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
        });

        await transition(
            ticket.id,
            admin.accessToken,
            "IN_PROGRESS"
        ).expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it.each([
        {
            from: "OPEN",
            to: "IN_PROGRESS",
        },
        {
            from: "IN_PROGRESS",
            to: "RESOLVED",
        },
    ] as const)(
        "should prohibit requester-only transition $from -> $to",
        async ({ from, to }) => {
            const requester = await createTicketActor("USER");
            const employee = await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status: from,
            });

            await transition(
                ticket.id,
                requester.accessToken,
                to
            ).expect(403);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should prohibit unrelated employee transitions", async () => {
        const requester = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
        });

        await transition(
            ticket.id,
            employee.accessToken,
            "IN_PROGRESS"
        ).expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should conceal inaccessible ticket status operations", async () => {
        const owner = await createTicketActor("USER");
        const other = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            status: "RESOLVED",
        });

        await transition(
            ticket.id,
            other.accessToken,
            "CLOSED"
        ).expect(404);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it.each([
        { from: "OPEN", to: "OPEN" },
        { from: "OPEN", to: "RESOLVED" },
        { from: "OPEN", to: "CLOSED" },
        { from: "IN_PROGRESS", to: "OPEN" },
        { from: "IN_PROGRESS", to: "CLOSED" },
        { from: "RESOLVED", to: "IN_PROGRESS" },
        { from: "CLOSED", to: "OPEN" },
        { from: "CLOSED", to: "CLOSED" },
    ] as const)(
        "should reject invalid transition $from -> $to",
        async ({ from, to }) => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: admin.user.id,
                assigneeId: employee.user.id,
                status: from,
                updatedAt: new Date("2025-01-01"),
            });

            await transition(
                ticket.id,
                admin.accessToken,
                to
            ).expect(409);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should prevent conflicting concurrent status transitions", async () => {
        const admin = await createTicketActor("ADMIN");
        const requester = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: employee.user.id,
            status: "RESOLVED",
            updatedAt: new Date("2025-01-01"),
        });

        const responses = await Promise.all([
            transition(
                ticket.id,
                admin.accessToken,
                "OPEN"
            ),

            transition(
                ticket.id,
                requester.accessToken,
                "CLOSED"
            ),
        ]);

        expect(
            responses.map((response) => response.status).sort()
        ).toEqual([200, 409]);

        const reopened = responses[0]?.status === 200;

        const winner = reopened
            ? admin
            : requester;

        const successful = responses.find(
            (response) => response.status === 200
        );

        const updated = await getTestTicket(ticket.id);

        expect(updated).toMatchObject({
            status: reopened ? "OPEN" : "CLOSED",
            updatedById: winner.user.id,
            requesterId: ticket.requesterId,
            assigneeId: ticket.assigneeId,
            createdAt: ticket.createdAt,
        });

        expect(updated.updatedAt.toISOString())
            .toBe(successful?.body.data.updatedAt);
    });

    it("should reject duplicate concurrent status transitions", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
            assigneeId: employee.user.id,
            status: "OPEN",
        });

        const responses = await Promise.all([
            transition(
                ticket.id,
                admin.accessToken,
                "IN_PROGRESS"
            ),

            transition(
                ticket.id,
                employee.accessToken,
                "IN_PROGRESS"
            ),
        ]);

        expect(
            responses.map((response) => response.status).sort()
        ).toEqual([200, 409]);

        const winner = responses[0]?.status === 200
            ? admin
            : employee;

        expect(await getTestTicket(ticket.id))
            .toMatchObject({
                status: "IN_PROGRESS",
                updatedById: winner.user.id,
            });
    });

    it("should coordinate concurrent closure and assignment", async () => {
        const admin = await createTicketActor("ADMIN");
        const requester = await createTicketActor("USER");
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: first.user.id,
            status: "RESOLVED",
        });

        const [closure, assignment] = await Promise.all([
            transition(
                ticket.id,
                requester.accessToken,
                "CLOSED"
            ),

            api
                .patch(`${endpoint}/${ticket.id}/assignment`)
                .set(withAuth(admin.accessToken))
                .send({
                    assigneeId: second.user.id,
                }),
        ]);

        expect(closure.status).toBe(200);
        expect([200, 409]).toContain(assignment.status);

        const updated = await getTestTicket(ticket.id);

        expect(updated.status).toBe("CLOSED");

        expect(updated.assigneeId).toBe(
            assignment.status === 200
                ? second.user.id
                : first.user.id
        );

        expect(updated.updatedById)
            .toBe(requester.user.id);

        expect(updated.updatedAt.toISOString())
            .toBe(closure.body.data.updatedAt);

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .set(withAuth(admin.accessToken))
            .send({ assigneeId: null })
            .expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(updated);
    });

    it("should prohibit concurrent editing during closure", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
            status: "RESOLVED",
        });

        const [closure, modification] = await Promise.all([
            transition(
                ticket.id,
                admin.accessToken,
                "CLOSED"
            ),

            api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(admin.accessToken))
                .send({ title: "Invalid modification" }),
        ]);

        expect(closure.status).toBe(200);
        expect(modification.status).toBe(409);

        expect(await getTestTicket(ticket.id))
            .toMatchObject({
                status: "CLOSED",
                title: ticket.title,
                description: ticket.description,
                updatedById: admin.user.id,
            });
    });

    it("should enforce authentication and transition permissions", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:read"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
            status: "RESOLVED",
        });

        await api
            .patch(`${endpoint}/${ticket.id}/status`)
            .send({ status: "CLOSED" })
            .expect(401);

        await transition(
            ticket.id,
            token,
            "CLOSED"
        ).expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject invalid status payloads", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}/status`)
            .set(withAuth(admin.accessToken))
            .send({ status: "INVALID" })
            .expect(400);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });
});