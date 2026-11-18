import { randomUUID } from "node:crypto";

import {
    describe,
    expect,
    it,
} from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    createTicketActor,
    createTestTicket,
    getTestTicket,
} from "../../factories/ticket.factory.js";

import {
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    api,
} from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

import {
    setupSSETests,
} from "../../helpers/sse.helper.js";

import {
    PNG,
} from "../../fixtures/files/attachment.fixtures.js";

const profileEndpoint = "/api/v1/auth/me";
const ticketsEndpoint = "/api/v1/tickets";

const originalTimestamp = new Date("2025-01-01T00:00:00.000Z");

const updateName = (
    token: string,
    name: string
) =>
    api
        .patch(profileEndpoint)
        .set(withAuth(token))
        .send({ name })
        .expect(200);

const createAttachmentRecord = (
    ticketId: string,
    uploadedById: string
) => {
    const id = randomUUID();

    return prisma.ticketAttachment.create({
        data: {
            id,
            ticketId,
            uploadedById,
            fileName: "image.png",
            mimeType: "image/png",
            sizeBytes: PNG.length,
            storageKey: `tickets/${ticketId}/${id}`,
            createdAt: originalTimestamp,
        },
    });
};

describe("Profile Updates — Participant Consistency", () => {
    setupIntegrationTests();

    const { subscribe } = setupSSETests();

    it("should reflect updated requester, assignee and modifier names in ticket responses", async () => {
        const requester = await createTicketActor("USER");
        const assignee = await createTicketActor("EMPLOYEE");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: requester.user.id,
            assigneeId: assignee.user.id,
            updatedById: admin.user.id,
            updatedAt: originalTimestamp,
        });

        const detailEndpoint =
            `${ticketsEndpoint}/${ticket.id}`;

        const before = await api
            .get(detailEndpoint)
            .set(withAuth(admin.accessToken))
            .expect(200);

        await Promise.all([
            updateName(
                requester.accessToken,
                "Updated Requester"
            ),
            updateName(
                assignee.accessToken,
                "Updated Assignee"
            ),
            updateName(
                admin.accessToken,
                "Updated Administrator"
            ),
        ]);

        const expectedTicket = {
            ...before.body.data,

            requester: {
                id: requester.user.id,
                name: "Updated Requester",
            },

            assignee: {
                id: assignee.user.id,
                name: "Updated Assignee",
            },

            updatedBy: {
                id: admin.user.id,
                name: "Updated Administrator",
            },
        };

        for (const actor of [
            requester,
            assignee,
            admin,
        ]) {
            const detail = await api
                .get(detailEndpoint)
                .set(withAuth(actor.accessToken))
                .expect(200);

            expect(detail.body.data)
                .toEqual(expectedTicket);

            const list = await api
                .get(ticketsEndpoint)
                .set(withAuth(actor.accessToken))
                .expect(200);

            expect(list.body.data)
                .toContainEqual(expectedTicket);
        }

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reflect updated author names in existing and newly created comments", async () => {
        const owner = await createTicketActor("USER");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            updatedAt: originalTimestamp,
        });

        const endpoint =
            `${ticketsEndpoint}/${ticket.id}/comments`;

        const original = await api
            .post(endpoint)
            .set(withAuth(owner.accessToken))
            .send({
                content: "Original conversation message",
            })
            .expect(201);

        const originalRecord =
            await prisma.ticketComment.findUniqueOrThrow({
                where: {
                    id: original.body.data.id,
                },
            });

        await updateName(
            owner.accessToken,
            "Updated Comment Author"
        );

        const expectedComment = {
            ...original.body.data,

            author: {
                id: owner.user.id,
                name: "Updated Comment Author",
            },
        };

        for (const actor of [owner, admin]) {
            const response = await api
                .get(endpoint)
                .set(withAuth(actor.accessToken))
                .expect(200);

            expect(response.body).toEqual({
                data: [expectedComment],
            });
        }

        const created = await api
            .post(endpoint)
            .set(withAuth(owner.accessToken))
            .send({
                content: "Comment after profile update",
            })
            .expect(201);

        expect(created.body.data.author).toEqual({
            id: owner.user.id,
            name: "Updated Comment Author",
        });

        expect(
            await prisma.ticketComment.findUniqueOrThrow({
                where: { id: originalRecord.id },
            })
        ).toEqual(originalRecord);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reflect updated attachment uploader names without modifying attachment metadata", async () => {
        const owner = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: employee.user.id,
            updatedAt: originalTimestamp,
        });

        const attachment = await createAttachmentRecord(
            ticket.id,
            employee.user.id
        );

        const endpoint =
            `${ticketsEndpoint}/${ticket.id}/attachments`;

        const before = await api
            .get(endpoint)
            .set(withAuth(owner.accessToken))
            .expect(200);

        expect(before.body.data).toHaveLength(1);

        expect(before.body.data[0].uploadedBy).toEqual({
            id: employee.user.id,
            name: employee.user.name,
        });

        await updateName(
            employee.accessToken,
            "Updated Attachment Uploader"
        );

        const expectedAttachment = {
            ...before.body.data[0],

            uploadedBy: {
                id: employee.user.id,
                name: "Updated Attachment Uploader",
            },
        };

        for (const actor of [
            owner,
            employee,
            admin,
        ]) {
            const response = await api
                .get(endpoint)
                .set(withAuth(actor.accessToken))
                .expect(200);

            expect(response.body).toEqual({
                data: [expectedAttachment],
            });
        }

        expect(
            await prisma.ticketAttachment.findUniqueOrThrow({
                where: { id: attachment.id },
            })
        ).toEqual(attachment);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reflect updated author names in SSE reconnection snapshots and subsequent events", async () => {
        const owner = await createTicketActor("USER");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            updatedAt: originalTimestamp,
        });

        const endpoint =
            `${ticketsEndpoint}/${ticket.id}/comments`;

        const firstConnection = await subscribe(
            ticket.id,
            admin.accessToken
        );

        await firstConnection.nextEvent(
            "comments.snapshot"
        );

        const original = await api
            .post(endpoint)
            .set(withAuth(owner.accessToken))
            .send({
                content: "Comment before name update",
            })
            .expect(201);

        const originalEvent =
            await firstConnection.nextEvent(
                "comment.created"
            );

        expect(originalEvent.data.data.author).toEqual({
            id: owner.user.id,
            name: owner.user.name,
        });

        const originalRecord =
            await prisma.ticketComment.findUniqueOrThrow({
                where: {
                    id: original.body.data.id,
                },
            });

        firstConnection.close();

        await updateName(
            owner.accessToken,
            "Updated SSE Author"
        );

        const reconnected = await subscribe(
            ticket.id,
            admin.accessToken
        );

        const snapshot = await reconnected.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data).toEqual({
            data: [
                {
                    ...original.body.data,

                    author: {
                        id: owner.user.id,
                        name: "Updated SSE Author",
                    },
                },
            ],
        });

        const nextComment = await api
            .post(endpoint)
            .set(withAuth(owner.accessToken))
            .send({
                content: "Comment after name update",
            })
            .expect(201);

        const nextEvent = await reconnected.nextEvent(
            "comment.created"
        );

        expect(nextEvent.data).toEqual({
            data: nextComment.body.data,
        });

        expect(nextEvent.data.data.author).toEqual({
            id: owner.user.id,
            name: "Updated SSE Author",
        });

        expect(
            await prisma.ticketComment.findUniqueOrThrow({
                where: { id: originalRecord.id },
            })
        ).toEqual(originalRecord);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should reflect updated participant names on CLOSED tickets without modifying historical records", async () => {
        const owner = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: employee.user.id,
            updatedById: employee.user.id,
            status: "CLOSED",
            updatedAt: originalTimestamp,
        });

        const comment = await prisma.ticketComment.create({
            data: {
                ticketId: ticket.id,
                authorId: owner.user.id,
                content: "Historical comment",
                createdAt: originalTimestamp,
            },
        });

        const attachment = await createAttachmentRecord(
            ticket.id,
            employee.user.id
        );

        await updateName(
            owner.accessToken,
            "Updated Historical Requester"
        );

        await updateName(
            employee.accessToken,
            "Updated Historical Employee"
        );

        const endpoint =
            `${ticketsEndpoint}/${ticket.id}`;

        const detail = await api
            .get(endpoint)
            .set(withAuth(owner.accessToken))
            .expect(200);

        expect(detail.body.data).toMatchObject({
            status: "CLOSED",

            requester: {
                id: owner.user.id,
                name: "Updated Historical Requester",
            },

            assignee: {
                id: employee.user.id,
                name: "Updated Historical Employee",
            },

            updatedBy: {
                id: employee.user.id,
                name: "Updated Historical Employee",
            },
        });

        const comments = await api
            .get(`${endpoint}/comments`)
            .set(withAuth(owner.accessToken))
            .expect(200);

        expect(comments.body.data).toHaveLength(1);

        expect(comments.body.data[0].author).toEqual({
            id: owner.user.id,
            name: "Updated Historical Requester",
        });

        const attachments = await api
            .get(`${endpoint}/attachments`)
            .set(withAuth(owner.accessToken))
            .expect(200);

        expect(attachments.body.data).toHaveLength(1);

        expect(attachments.body.data[0].uploadedBy).toEqual({
            id: employee.user.id,
            name: "Updated Historical Employee",
        });

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);

        expect(
            await prisma.ticketComment.findUniqueOrThrow({
                where: { id: comment.id },
            })
        ).toEqual(comment);

        expect(
            await prisma.ticketAttachment.findUniqueOrThrow({
                where: { id: attachment.id },
            })
        ).toEqual(attachment);
    });
});