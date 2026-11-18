import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    createTicketActor,
    createTestTicket,
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

describe("Ticket Visibility", () => {
    setupIntegrationTests();

    async function createVisibilityFixtures() {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const otherEmployee = await createTicketActor("EMPLOYEE");
        const user = await createTicketActor("USER");
        const otherUser = await createTicketActor("USER");

        const unassigned = await createTestTicket({
            requesterId: otherUser.user.id,
        });

        const assigned = await createTestTicket({
            requesterId: user.user.id,
            assigneeId: employee.user.id,
        });

        const requested = await createTestTicket({
            requesterId: employee.user.id,
            assigneeId: otherEmployee.user.id,
        });

        const shared = await createTestTicket({
            requesterId: employee.user.id,
            assigneeId: employee.user.id,
        });

        const inaccessible = await createTestTicket({
            requesterId: otherUser.user.id,
            assigneeId: otherEmployee.user.id,
        });

        const closed = await createTestTicket({
            requesterId: user.user.id,
            assigneeId: employee.user.id,
            status: "CLOSED",
        });

        return {
            admin,
            employee,
            otherEmployee,
            user,
            otherUser,
            unassigned,
            assigned,
            requested,
            shared,
            inaccessible,
            closed,
        };
    }

    async function expectVisibleTickets(
        token: string,
        expectedIds: string[]
    ) {
        const response = await api
            .get(endpoint)
            .set(withAuth(token))
            .expect(200);

        const ids = response.body.data.map(
            (ticket: { id: string }) => ticket.id
        );

        expect(ids.sort()).toEqual([...expectedIds].sort());

        expect(response.body.pagination).toEqual({
            page: 1,
            limit: 20,
            total: expectedIds.length,
            totalPages: Math.ceil(expectedIds.length / 20),
        });
    }

    it("should expose all tickets to ADMIN", async () => {
        const f = await createVisibilityFixtures();

        await expectVisibleTickets(
            f.admin.accessToken,
            [
                f.unassigned.id,
                f.assigned.id,
                f.requested.id,
                f.shared.id,
                f.inaccessible.id,
                f.closed.id,
            ]
        );
    });

    it("should combine employee visibility without duplicate records", async () => {
        const f = await createVisibilityFixtures();

        await expectVisibleTickets(
            f.employee.accessToken,
            [
                f.unassigned.id,
                f.assigned.id,
                f.requested.id,
                f.shared.id,
                f.closed.id,
            ]
        );
    });

    it("should restrict USER visibility to owned tickets", async () => {
        const f = await createVisibilityFixtures();

        await expectVisibleTickets(
            f.user.accessToken,
            [
                f.assigned.id,
                f.closed.id,
            ]
        );
    });

    it("should enforce resource visibility on ticket details", async () => {
        const f = await createVisibilityFixtures();

        for (const ticket of [
            f.unassigned,
            f.assigned,
            f.requested,
            f.shared,
            f.closed,
        ]) {
            await api
                .get(`${endpoint}/${ticket.id}`)
                .set(withAuth(f.employee.accessToken))
                .expect(200);
        }

        await api
            .get(`${endpoint}/${f.inaccessible.id}`)
            .set(withAuth(f.employee.accessToken))
            .expect(404);

        await api
            .get(`${endpoint}/${f.inaccessible.id}`)
            .set(withAuth(f.user.accessToken))
            .expect(404);

        await api
            .get(`${endpoint}/${f.closed.id}`)
            .set(withAuth(f.user.accessToken))
            .expect(200);
    });

    it("should return identical errors for missing and inaccessible tickets", async () => {
        const f = await createVisibilityFixtures();

        const missing = await api
            .get(`${endpoint}/${randomUUID()}`)
            .set(withAuth(f.user.accessToken))
            .expect(404);

        const inaccessible = await api
            .get(`${endpoint}/${f.inaccessible.id}`)
            .set(withAuth(f.user.accessToken))
            .expect(404);

        expect(missing.body).toEqual(inaccessible.body);
    });

    it("should update visibility after reassignment while preserving ownership", async () => {
        const f = await createVisibilityFixtures();

        for (const ticket of [f.assigned, f.shared]) {
            await api
                .patch(`${endpoint}/${ticket.id}/assignment`)
                .set(withAuth(f.admin.accessToken))
                .send({
                    assigneeId: f.otherEmployee.user.id,
                })
                .expect(200);
        }

        await api
            .get(`${endpoint}/${f.assigned.id}`)
            .set(withAuth(f.employee.accessToken))
            .expect(404);

        await api
            .get(`${endpoint}/${f.shared.id}`)
            .set(withAuth(f.employee.accessToken))
            .expect(200);

        await api
            .get(`${endpoint}/${f.assigned.id}`)
            .set(withAuth(f.otherEmployee.accessToken))
            .expect(200);

        await api
            .get(`${endpoint}/${f.assigned.id}`)
            .set(withAuth(f.user.accessToken))
            .expect(200);
    });

    it("should return an empty authorized collection", async () => {
        const user = await createTicketActor("USER");
        const other = await createTicketActor("USER");

        await createTestTicket({
            requesterId: other.user.id,
        });

        await expectVisibleTickets(user.accessToken, []);
    });

    it("should enforce deterministic default ordering", async () => {
        const user = await createTicketActor("USER");

        const earlier = await createTestTicket({
            requesterId: user.user.id,
            createdAt: new Date("2025-01-01"),
        });

        const first = await createTestTicket({
            requesterId: user.user.id,
            createdAt: new Date("2025-02-01"),
        });

        const second = await createTestTicket({
            requesterId: user.user.id,
            createdAt: first.createdAt,
        });

        const response = await api
            .get(endpoint)
            .set(withAuth(user.accessToken))
            .expect(200);

        expect(response.body.data.map(
            (ticket: { id: string }) => ticket.id
        )).toEqual([
            ...[first.id, second.id].sort().reverse(),
            earlier.id,
        ]);
    });

    it("should apply the default page limit without losing the total count", async () => {
        const user = await createTicketActor("USER");

        await Promise.all(
            Array.from({ length: 21 }, () =>
                createTestTicket({
                    requesterId: user.user.id,
                })
            )
        );

        const response = await api
            .get(endpoint)
            .set(withAuth(user.accessToken))
            .expect(200);

        expect(response.body.data).toHaveLength(20);

        expect(response.body.pagination).toEqual({
            page: 1,
            limit: 20,
            total: 21,
            totalPages: 2,
        });
    });

    it("should require authentication and ticket:read", async () => {
        const { user } = await createTestUser({
            role: "USER",
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await api.get(endpoint).expect(401);

        await api
            .get(`${endpoint}/${ticket.id}`)
            .expect(401);

        await api
            .get(endpoint)
            .set(withAuth(token))
            .expect(403);

        await api
            .get(`${endpoint}/${ticket.id}`)
            .set(withAuth(token))
            .expect(403);
    });

    it("should reject malformed ticket identifiers", async () => {
        const actor = await createTicketActor("ADMIN");

        await api
            .get(`${endpoint}/invalid-id`)
            .set(withAuth(actor.accessToken))
            .expect(400);
    });
});