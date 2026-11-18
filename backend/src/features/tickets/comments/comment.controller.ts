import type {
    Request,
    Response,
} from "express";

import logger from "../../../config/logger.js";

import {
    getBearerToken,
} from "../../../middlewares/auth.middleware.js";

import {
    getActor,
    getTicketId,
} from "../ticket.controller.js";

import type {
    CreateCommentData,
} from "./comment.schema.js";

import {
    subscribeToComments,
    publishComment,
} from "./comment.events.js";

import * as commentService from "./comment.service.js";

const getComments = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const comments = await commentService.getComments(
        actor,
        ticketId
    );

    response.status(200).json({
        data: comments,
    });
};

const createComment = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const data: CreateCommentData = request.body;

    // Resolves only after successful transaction commit.
    const comment = await commentService.createComment(
        actor,
        ticketId,
        data
    );

    // Delivery failures must not invalidate an already
    // committed database operation.
    void publishComment(comment).catch(() => {
        logger.warn("Comment publication failed", {
            ticketId: comment.ticketId,
            commentId: comment.id,
        });
    });

    response.status(201).json({
        data: comment,
    });
};

const streamComments = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const accessToken = getBearerToken(
        request.headers.authorization
    );

    await subscribeToComments(
        ticketId,
        actor.id,
        accessToken,
        response
    );
};

export {
    getComments,
    createComment,
    streamComments,
};