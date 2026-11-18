import { randomUUID } from "node:crypto";

import {
    AppError,
} from "../../../errors/AppError.js";

import {
    getStorageBucket,
    MAX_ATTACHMENTS,
    SIGNED_URL_TTL_SECONDS,
} from "../../../config/storage.js";

import {
    PERMISSIONS,
} from "../../rbac/rbac.constants.js";

import {
    assertTicketNotClosed,
} from "../ticket.authorization.js";

import {
    withTicketTransaction,
    assertCurrentTicketActor,
    getLockedVisibleTicket,
} from "../ticket.service.js";

import {
    ticketAttachmentSelect,
    toTicketAttachmentResponse,
} from "../ticket.types.js";

import type {
    TicketActor,
    TicketAttachment,
    AttachmentDownload,
} from "../ticket.types.js";

import type {
    ValidatedAttachment,
} from "./attachment.schema.js";

import {
    removeUnreferencedObject,
} from "./attachment.cleanup.js";

const assertAttachmentUploadAllowed = async (
    actor: TicketActor,
    ticketId: string
): Promise<void> => {
    await withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_ATTACH
        );

        const ticket = await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        assertTicketNotClosed(ticket);

        const attachmentCount =
            await tx.ticketAttachment.count({
                where: { ticketId },
            });

        if (attachmentCount >= MAX_ATTACHMENTS) {
            throw new AppError(
                "Ticket attachment limit reached",
                409
            );
        }
    });
};

const createAttachment = async (
    actor: TicketActor,
    ticketId: string,
    file: ValidatedAttachment
): Promise<TicketAttachment> => {
    // Revalidate before starting the external operation.
    await assertAttachmentUploadAllowed(
        actor,
        ticketId
    );

    const id = randomUUID();

    const storageKey = `tickets/${ticketId}/${id}`;

    try {
        // External operation intentionally occurs outside
        // the PostgreSQL transaction.
        const { error } = await getStorageBucket().upload(
            storageKey,
            file.buffer,
            {
                contentType: file.mimeType,
                upsert: false,
                cacheControl: "0",
            }
        );

        if (error) {
            throw new Error("Storage upload failed");
        }
    } catch {
        // An unsuccessful response may still represent
        // an object accepted by the storage provider.
        await removeUnreferencedObject(storageKey);

        throw new AppError(
            "Storage upload failed",
            503
        );
    }

    try {
        return await withTicketTransaction(async (tx) => {
            await assertCurrentTicketActor(
                tx,
                actor,
                PERMISSIONS.TICKET_ATTACH
            );

            const ticket = await getLockedVisibleTicket(
                tx,
                actor,
                ticketId
            );

            assertTicketNotClosed(ticket);

            const attachmentCount =
                await tx.ticketAttachment.count({
                    where: { ticketId },
                });

            if (attachmentCount >= MAX_ATTACHMENTS) {
                throw new AppError(
                    "Ticket attachment limit reached",
                    409
                );
            }

            const attachment =
                await tx.ticketAttachment.create({
                    data: {
                        id,
                        ticketId,
                        uploadedById: actor.id,
                        fileName: file.fileName,
                        mimeType: file.mimeType,
                        sizeBytes: file.sizeBytes,
                        storageKey,
                    },

                    select: ticketAttachmentSelect,
                });

            return toTicketAttachmentResponse(
                attachment
            );
        });
    } catch (error) {
        await removeUnreferencedObject(storageKey);

        throw error;
    }
};

const getAttachments = async (
    actor: TicketActor,
    ticketId: string
): Promise<TicketAttachment[]> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_READ
        );

        await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        const attachments =
            await tx.ticketAttachment.findMany({
                where: { ticketId },

                select: ticketAttachmentSelect,

                orderBy: [
                    { createdAt: "asc" },
                    { id: "asc" },
                ],
            });

        return attachments.map(
            toTicketAttachmentResponse
        );
    });
};

const getAttachmentDownload = async (
    actor: TicketActor,
    ticketId: string,
    attachmentId: string
): Promise<AttachmentDownload> => {
    return withTicketTransaction(async (tx) => {
        await assertCurrentTicketActor(
            tx,
            actor,
            PERMISSIONS.TICKET_READ
        );

        await getLockedVisibleTicket(
            tx,
            actor,
            ticketId
        );

        const attachment =
            await tx.ticketAttachment.findFirst({
                where: {
                    id: attachmentId,
                    ticketId,
                },

                select: {
                    storageKey: true,
                    fileName: true,
                },
            });

        if (!attachment) {
            throw new AppError(
                "Attachment not found",
                404
            );
        }

        const expiresAt = new Date(
            Date.now() + SIGNED_URL_TTL_SECONDS * 1000
        ).toISOString();

        try {
            const { data, error } =
                await getStorageBucket()
                    .createSignedUrl(
                        attachment.storageKey,
                        SIGNED_URL_TTL_SECONDS,
                        {
                            download: attachment.fileName,
                        }
                    );

            if (error || !data?.signedUrl) {
                throw new Error(
                    "Signed URL generation failed"
                );
            }

            return {
                downloadUrl: data.signedUrl,
                expiresAt,
            };
        } catch {
            throw new AppError(
                "Storage download unavailable",
                503
            );
        }
    });
};

export {
    assertAttachmentUploadAllowed,
    createAttachment,
    getAttachments,
    getAttachmentDownload,
};