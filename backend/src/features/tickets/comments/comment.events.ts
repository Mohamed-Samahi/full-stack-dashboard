import type { Response } from "express";

import type {
    Prisma,
} from "../../../generated/prisma/client.js";

import logger from "../../../config/logger.js";

import {
    AppError,
} from "../../../errors/AppError.js";

import {
    authenticateAccessToken,
} from "../../../middlewares/auth.middleware.js";

import {
    verifyAccessToken,
} from "../../../utils/jwt.js";

import {
    PERMISSIONS,
} from "../../rbac/rbac.constants.js";

import {
    withTicketTransaction,
    assertCurrentTicketActor,
    getLockedVisibleTicket,
} from "../ticket.service.js";

import type {
    TicketComment,
    TicketCommentEventMap,
} from "../ticket.types.js";

import {
    listTicketComments,
} from "./comment.service.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_INTERVAL_MS = 3_000;

type CommentSubscriber = {
    ticketId: string;
    userId: string;
    accessToken: string;
    response: Response;

    active: boolean;
    checking: boolean;

    heartbeat: ReturnType<typeof setInterval> | undefined;
};

const subscriptions = new Map<
    string,
    Set<CommentSubscriber>
>();

let shuttingDown = false;

const removeSubscriber = (
    subscriber: CommentSubscriber
): void => {
    subscriber.active = false;

    if (subscriber.heartbeat) {
        clearInterval(subscriber.heartbeat);
        subscriber.heartbeat = undefined;
    }

    const subscribers = subscriptions.get(
        subscriber.ticketId
    );

    subscribers?.delete(subscriber);

    if (subscribers?.size === 0) {
        subscriptions.delete(subscriber.ticketId);
    }
};

const closeSubscriber = (
    subscriber: CommentSubscriber
): void => {
    removeSubscriber(subscriber);

    if (
        !subscriber.response.destroyed &&
        !subscriber.response.writableEnded
    ) {
        subscriber.response.end();
    }
};

const isConnected = (
    subscriber: CommentSubscriber
): boolean => {
    return (
        subscriber.active &&
        !subscriber.response.destroyed &&
        !subscriber.response.writableEnded
    );
};

const MAX_PENDING_BYTES = 1024 * 1024;

const writeFrame = (
    subscriber: CommentSubscriber,
    frame: string
): void => {
    if (!isConnected(subscriber)) {
        removeSubscriber(subscriber);
        return;
    }

    if (
        subscriber.response.writableLength >
        MAX_PENDING_BYTES
    ) {
        removeSubscriber(subscriber);
        subscriber.response.destroy();
        return;
    }

    subscriber.response.write(frame);
};

const writeEvent = <
    Event extends keyof TicketCommentEventMap
>(
    subscriber: CommentSubscriber,
    event: Event,
    payload: TicketCommentEventMap[Event]
): void => {
    writeFrame(
        subscriber,
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    );
};

const assertTokenNotExpired = (
    token: string
): void => {
    try {
        verifyAccessToken(token);
    } catch {
        throw new AppError(
            "Invalid or expired token",
            401
        );
    }
};

const assertSubscriptionAccess = async (
    tx: Prisma.TransactionClient,
    subscriber: CommentSubscriber
): Promise<void> => {
    // Prevent concurrent user authentication-version
    // changes while authorizing and delivering an event.
    const users = await tx.$queryRaw<
        { id: string }[]
    >`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${subscriber.userId}
        FOR SHARE
    `;

    if (users.length === 0) {
        throw new AppError(
            "Invalid or revoked token",
            401
        );
    }

    // Revalidate JWT expiration, role identity,
    // user version and role version against PostgreSQL.
    const actor = await authenticateAccessToken(
        subscriber.accessToken,
        tx
    );

    if (actor.id !== subscriber.userId) {
        throw new AppError("Forbidden", 403);
    }

    await assertCurrentTicketActor(
        tx,
        actor,
        PERMISSIONS.TICKET_READ
    );

    await getLockedVisibleTicket(
        tx,
        actor,
        subscriber.ticketId
    );
};

const handleStreamError = (
    subscriber: CommentSubscriber,
    error: unknown
): void => {
    if (!isConnected(subscriber)) {
        removeSubscriber(subscriber);
        return;
    }

    const status =
        error instanceof AppError
            ? error.statusCode
            : 503;

    let message = "Comment stream unavailable";

    if (status === 401) {
        message = "Invalid or revoked authentication";
    } else if (status === 403) {
        message = "Forbidden";
    } else if (status === 404) {
        message = "Ticket not found";
    } else {
        logger.warn("Comment stream authorization failed", {
            ticketId: subscriber.ticketId,
        });
    }

    try {
        writeEvent(
            subscriber,
            "stream.error",
            {
                status,
                message,
            }
        );
    } finally {
        closeSubscriber(subscriber);
    }
};

const revalidateAndSend = async (
    subscriber: CommentSubscriber,
    send: () => void
): Promise<void> => {
    if (!isConnected(subscriber)) {
        return;
    }

    try {
        await withTicketTransaction(async (tx) => {
            if (!isConnected(subscriber)) {
                return;
            }

            await assertSubscriptionAccess(
                tx,
                subscriber
            );

            // Check again immediately before delivery.
            assertTokenNotExpired(
                subscriber.accessToken
            );

            if (isConnected(subscriber)) {
                send();
            }
        });
    } catch (error) {
        handleStreamError(subscriber, error);
    }
};

const sendHeartbeat = async (
    subscriber: CommentSubscriber
): Promise<void> => {
    if (
        !isConnected(subscriber) ||
        subscriber.checking
    ) {
        return;
    }

    subscriber.checking = true;

    try {
        await revalidateAndSend(
            subscriber,
            () => {
                writeFrame(
                    subscriber,
                    ": heartbeat\n\n"
                );
            }
        );
    } finally {
        subscriber.checking = false;
    }
};

const subscribeToComments = async (
    ticketId: string,
    userId: string,
    accessToken: string,
    response: Response
): Promise<void> => {
    if (shuttingDown) {
        throw new AppError(
            "Comment stream unavailable",
            503
        );
    }

    const subscriber: CommentSubscriber = {
        ticketId,
        userId,
        accessToken,
        response,

        active: true,
        checking: false,
        heartbeat: undefined,
    };

    response.once("close", () => {
        removeSubscriber(subscriber);
    });

    response.once("error", () => {
        removeSubscriber(subscriber);
    });

    try {
        await withTicketTransaction(async (tx) => {
            await assertSubscriptionAccess(
                tx,
                subscriber
            );

            const comments = await listTicketComments(
                tx,
                ticketId
            );

            assertTokenNotExpired(accessToken);

            if (!isConnected(subscriber)) {
                return;
            }

            if (shuttingDown) {
                throw new AppError(
                    "Comment stream unavailable",
                    503
                );
            }

            response.status(200);

            response.set({
                "Content-Type":
                    "text/event-stream; charset=utf-8",

                "Cache-Control":
                    "no-cache, no-store, no-transform",

                "X-Accel-Buffering": "no",
            });

            response.flushHeaders();

            let subscribers = subscriptions.get(ticketId);

            if (!subscribers) {
                subscribers = new Set<CommentSubscriber>();
                subscriptions.set(ticketId, subscribers);
            }

            subscribers.add(subscriber);

            writeFrame(
                subscriber,
                `retry: ${RECONNECT_INTERVAL_MS}\n\n`
            );

            writeEvent(
                subscriber,
                "comments.snapshot",
                {
                    data: comments,
                }
            );
        });

        if (isConnected(subscriber)) {
            subscriber.heartbeat = setInterval(() => {
                void sendHeartbeat(subscriber).catch(() => {
                    removeSubscriber(subscriber);
                    response.destroy();
                });
            }, HEARTBEAT_INTERVAL_MS);

            subscriber.heartbeat.unref();
        }
    } catch (error) {
        if (!response.headersSent) {
            removeSubscriber(subscriber);
            throw error;
        }

        handleStreamError(subscriber, error);
    }
};

const publishComment = async (
    comment: TicketComment
): Promise<void> => {
    const subscribers = subscriptions.get(
        comment.ticketId
    );

    if (!subscribers?.size) {
        return;
    }

    const recipients = [...subscribers];

    const results = await Promise.allSettled(
        recipients.map((subscriber) =>
            revalidateAndSend(
                subscriber,
                () => {
                    writeEvent(
                        subscriber,
                        "comment.created",
                        {
                            data: comment,
                        }
                    );
                }
            )
        )
    );

    for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
            const subscriber = recipients[index];

            if (subscriber) {
                removeSubscriber(subscriber);
                subscriber.response.destroy();
            }

            logger.warn("Comment event delivery failed", {
                ticketId: comment.ticketId,
            });
        }
    }
};

const closeCommentStreams = (): void => {
    shuttingDown = true;

    for (const subscribers of subscriptions.values()) {
        for (const subscriber of subscribers) {
            removeSubscriber(subscriber);
            subscriber.response.destroy();
        }
    }

    subscriptions.clear();
};

export {
    subscribeToComments,
    publishComment,
    closeCommentStreams,
};