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

const previousTimestamp = new Date(
    "2025-01-01T00:00:00.000Z"
);

describe("Ticket Updates", () => {
    setupIntegrationTests();

    it.each([
        { role: "ADMIN", status: "OPEN" },
        { role: "ADMIN", status: "IN_PROGRESS" },
        { role: "EMPLOYEE", status: "OPEN" },
        { role: "EMPLOYEE", status: "IN_PROGRESS" },
    ] as const)(
        "should permit $role field updates on $status tickets",
        async ({ role, status }) => {
            const actor = await createTicketActor(role);
            const requester = await createTicketActor("USER");
            const employee = role === "EMPLOYEE"
                ? actor
                : await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status,
                updatedAt: previousTimestamp,
            });

            const payload = {
                title: "Updated title",
                description: "Updated description",
                priority: "HIGH",
            };

            const response = await api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(actor.accessToken))
                .send(payload)
                .expect(200);

            const updated = await getTestTicket(ticket.id);

            expect(updated).toMatchObject({
                ...payload,
                requesterId: ticket.requesterId,
                assigneeId: ticket.assigneeId,
                status: ticket.status,
                createdAt: ticket.createdAt,
                updatedById: actor.user.id,
            });

            expect(updated.updatedAt.getTime())
                .toBeGreaterThan(ticket.updatedAt.getTime());

            expect(response.body.data.updatedBy).toEqual({
                id: actor.user.id,
                name: actor.user.name,
            });

            expect(response.body.data.updatedAt)
                .toBe(updated.updatedAt.toISOString());
        }
    );

    it.each(["USER", "EMPLOYEE"] as const)(
        "should permit %s requester to edit an open ticket",
        async (role) => {
            const requester = await createTicketActor(role);

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
            });

            await api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(requester.accessToken))
                .send({
                    title: "  New title  ",
                    description: "New description",
                })
                .expect(200);

            expect(await getTestTicket(ticket.id))
                .toMatchObject({
                    title: "New title",
                    description: "New description",
                    updatedById: requester.user.id,
                    priority: ticket.priority,
                });
        }
    );

    it("should combine employee requester and assignee rights", async () => {
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: employee.user.id,
            assigneeId: employee.user.id,
            status: "IN_PROGRESS",
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(employee.accessToken))
            .send({
                title: "Updated",
                priority: "HIGH",
            })
            .expect(200);

        expect(await getTestTicket(ticket.id))
            .toMatchObject({
                title: "Updated",
                priority: "HIGH",
            });
    });

    it.each(["USER", "EMPLOYEE"] as const)(
        "should reject mixed authorized and unauthorized fields for %s requester",
        async (role) => {
            const requester = await createTicketActor(role);

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                updatedAt: previousTimestamp,
            });

            await api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(requester.accessToken))
                .send({
                    title: "Unauthorized mixed update",
                    priority: "HIGH",
                })
                .expect(403);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should reject requester editing after work starts", async () => {
        const requester = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: employee.user.id,
            status: "IN_PROGRESS",
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(requester.accessToken))
            .send({ title: "Updated title" })
            .expect(409);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject unrelated employee editing despite read visibility", async () => {
        const requester = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(employee.accessToken))
            .send({ title: "Updated title" })
            .expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should conceal inaccessible tickets when editing", async () => {
        const requester = await createTicketActor("USER");
        const other = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(other.accessToken))
            .send({ title: "Updated title" })
            .expect(404);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it.each(["RESOLVED", "CLOSED"] as const)(
        "should prohibit ADMIN editing in %s",
        async (status) => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: admin.user.id,
                assigneeId: employee.user.id,
                status,
            });

            await api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(admin.accessToken))
                .send({ title: "Updated title" })
                .expect(409);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should preserve metadata for unchanged updates", async () => {
        const admin = await createTicketActor("ADMIN");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            updatedById: requester.user.id,
            updatedAt: previousTimestamp,
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(admin.accessToken))
            .send({
                title: ` ${ticket.title} `,
                description: ticket.description,
                priority: ticket.priority,
            })
            .expect(200);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reject invalid fields without modifying metadata", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
        });

        for (const payload of [
            {},
            { title: "" },
            { status: "CLOSED" },
            { requesterId: admin.user.id },
            { updatedById: admin.user.id },
        ]) {
            await api
                .patch(`${endpoint}/${ticket.id}`)
                .set(withAuth(admin.accessToken))
                .send(payload)
                .expect(400);
        }

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should enforce authentication and update permissions", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:read"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .send({ title: "Updated" })
            .expect(401);

        await api
            .patch(`${endpoint}/${ticket.id}`)
            .set(withAuth(token))
            .send({ title: "Updated" })
            .expect(403);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });
});