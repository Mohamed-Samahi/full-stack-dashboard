import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    createTicketActor,
    createTestTicket,
    getTestTicket,
} from "../../factories/ticket.factory.js";

import { api } from "../../helpers/api.helper.js";

import { withAuth } from "../../helpers/auth.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const ticketEndpoint = "/api/v1/tickets";
const rbacEndpoint = "/api/v1/rbac/users";

const changeRole = (
    userId: string,
    roleId: string,
    token: string
) =>
    api
        .patch(`${rbacEndpoint}/${userId}/role`)
        .set(withAuth(token))
        .send({ roleId });

const assign = (
    ticketId: string,
    assigneeId: string | null,
    token: string
) =>
    api
        .patch(`${ticketEndpoint}/${ticketId}/assignment`)
        .set(withAuth(token))
        .send({ assigneeId });

const getUser = (id: string) =>
    prisma.user.findUniqueOrThrow({
        where: { id },
        include: {
            role: true,
        },
    });

const activeStatuses = [
    "OPEN",
    "IN_PROGRESS",
    "RESOLVED",
] as const;

const demotionCases = activeStatuses.flatMap(
    (status) =>
        (["USER", "ADMIN"] as const).map(
            (targetRole) => ({
                status,
                targetRole,
            })
        )
);

describe("Ticket Assignment and Employee Demotion Integrity", () => {
    setupIntegrationTests();

    it.each(demotionCases)(
        "should block employee role change to $targetRole with a $status assignment",
        async ({ status, targetRole }) => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const requester = await createTicketActor("USER");

            const targetRoleId = targetRole === "ADMIN"
                ? admin.user.roleId
                : requester.user.roleId;

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status,
            });

            const before = await getUser(employee.user.id);

            await changeRole(
                employee.user.id,
                targetRoleId,
                admin.accessToken
            ).expect(409);

            expect(await getUser(employee.user.id))
                .toEqual(before);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("should permit demotion when all assigned tickets are CLOSED", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const user = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: user.user.id,
            assigneeId: employee.user.id,
            updatedById: employee.user.id,
            status: "CLOSED",
        });

        await changeRole(
            employee.user.id,
            user.user.roleId,
            admin.accessToken
        ).expect(200);

        const updated = await getUser(employee.user.id);

        expect(updated.role.name).toBe("USER");

        expect(updated.authVersion)
            .toBe(employee.user.authVersion + 1);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should preserve requester ownership and modification authorship during demotion", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const user = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: employee.user.id,
            updatedById: employee.user.id,
            assigneeId: null,
            status: "OPEN",
        });

        await changeRole(
            employee.user.id,
            user.user.roleId,
            admin.accessToken
        ).expect(200);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);

        expect((await getUser(employee.user.id)).role.name)
            .toBe("USER");
    });

    it.each(["reassign", "unassign", "close"] as const)(
        "should permit demotion after resolving active assignments through %s",
        async (operation) => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const replacement = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: user.user.id,
                assigneeId: employee.user.id,
                status: "RESOLVED",
            });

            await changeRole(
                employee.user.id,
                user.user.roleId,
                admin.accessToken
            ).expect(409);

            if (operation === "close") {
                await api
                    .patch(`${ticketEndpoint}/${ticket.id}/status`)
                    .set(withAuth(admin.accessToken))
                    .send({
                        status: "CLOSED",
                    })
                    .expect(200);
            } else {
                await assign(
                    ticket.id,
                    operation === "reassign"
                        ? replacement.user.id
                        : null,
                    admin.accessToken
                ).expect(200);
            }

            const beforeDemotion = await getTestTicket(
                ticket.id
            );

            await changeRole(
                employee.user.id,
                user.user.roleId,
                admin.accessToken
            ).expect(200);

            expect((await getUser(employee.user.id)).role.name)
                .toBe("USER");

            expect(await getTestTicket(ticket.id))
                .toEqual(beforeDemotion);
        }
    );

    it("should reject assignment after employee demotion", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const user = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: user.user.id,
        });

        await changeRole(
            employee.user.id,
            user.user.roleId,
            admin.accessToken
        ).expect(200);

        await assign(
            ticket.id,
            employee.user.id,
            admin.accessToken
        ).expect(400);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should coordinate concurrent administrative assignment and employee demotion", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const user = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: user.user.id,
        });

        const [assignment, demotion] = await Promise.all([
            assign(
                ticket.id,
                employee.user.id,
                admin.accessToken
            ),

            changeRole(
                employee.user.id,
                user.user.roleId,
                admin.accessToken
            ),
        ]);

        const updatedTicket = await getTestTicket(ticket.id);
        const updatedUser = await getUser(employee.user.id);

        if (assignment.status === 200) {
            expect(demotion.status).toBe(409);

            expect(updatedUser.role.name).toBe("EMPLOYEE");

            expect(updatedUser.authVersion)
                .toBe(employee.user.authVersion);

            expect(updatedTicket.assigneeId)
                .toBe(employee.user.id);

            expect(updatedTicket.updatedById)
                .toBe(admin.user.id);
        } else {
            expect(assignment.status).toBe(400);
            expect(demotion.status).toBe(200);

            expect(updatedUser.role.name).toBe("USER");

            expect(updatedUser.authVersion)
                .toBe(employee.user.authVersion + 1);

            expect(updatedTicket).toEqual(ticket);
        }

        expect(await prisma.ticket.count({
            where: {
                status: {
                    not: "CLOSED",
                },
                assignee: {
                    is: {
                        role: {
                            name: {
                                not: "EMPLOYEE",
                            },
                        },
                    },
                },
            },
        })).toBe(0);
    });

    it("should coordinate concurrent self-assignment and employee demotion", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
        });

        const [assignment, demotion] = await Promise.all([
            assign(
                ticket.id,
                employee.user.id,
                employee.accessToken
            ),

            changeRole(
                employee.user.id,
                requester.user.roleId,
                admin.accessToken
            ),
        ]);

        const updatedTicket = await getTestTicket(ticket.id);
        const updatedUser = await getUser(employee.user.id);

        if (assignment.status === 200) {
            expect(demotion.status).toBe(409);

            expect(updatedUser.role.name).toBe("EMPLOYEE");

            expect(updatedTicket.assigneeId)
                .toBe(employee.user.id);

            expect(updatedTicket.updatedById)
                .toBe(employee.user.id);

            expect(updatedUser.authVersion)
                .toBe(employee.user.authVersion);
        } else {
            expect(assignment.status).toBe(401);
            expect(demotion.status).toBe(200);

            expect(updatedUser.role.name).toBe("USER");

            expect(updatedUser.authVersion)
                .toBe(employee.user.authVersion + 1);

            expect(updatedTicket).toEqual(ticket);
        }
    });

    it("should recheck employee visibility during concurrent reassignment and editing", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const replacement = await createTicketActor("EMPLOYEE");
        const requester = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: employee.user.id,
        });

        const [reassignment, modification] =
            await Promise.all([
                assign(
                    ticket.id,
                    replacement.user.id,
                    admin.accessToken
                ),

                api
                    .patch(`${ticketEndpoint}/${ticket.id}`)
                    .set(withAuth(employee.accessToken))
                    .send({
                        title: "Employee modification",
                    }),
            ]);

        expect(reassignment.status).toBe(200);

        expect([200, 404])
            .toContain(modification.status);

        const updated = await getTestTicket(ticket.id);

        expect(updated.assigneeId)
            .toBe(replacement.user.id);

        expect(updated.updatedById)
            .toBe(admin.user.id);

        expect(updated.title).toBe(
            modification.status === 200
                ? "Employee modification"
                : ticket.title
        );

        expect(updated.updatedAt.toISOString())
            .toBe(reassignment.body.data.updatedAt);

        await api
            .patch(`${ticketEndpoint}/${ticket.id}`)
            .set(withAuth(employee.accessToken))
            .send({
                title: "Unauthorized modification",
            })
            .expect(404);

        expect(await getTestTicket(ticket.id))
            .toEqual(updated);
    });
});