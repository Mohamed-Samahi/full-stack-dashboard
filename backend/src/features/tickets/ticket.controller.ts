import type {
    Request,
    Response,
} from "express";

import { AppError } from "../../errors/AppError.js";

import type {
    TicketActor,
} from "./ticket.types.js";

import type {
    CreateTicketData,
    UpdateTicketData,
    AssignTicketData,
    UpdateTicketStatusData,
    ListTicketsQuery,
} from "./ticket.schema.js";

import * as ticketService from "./ticket.service.js";

const getActor = (
    request: Request
): TicketActor => {
    if (!request.user) {
        throw new AppError(
            "Authentication required",
            401
        );
    }

    return request.user;
};

const getTicketId = (
    request: Request
): string => {
    const ticketId = request.params.ticketId;

    if (typeof ticketId !== "string") {
        throw new AppError(
            "Invalid ticket identifier",
            400
        );
    }

    return ticketId;
};

const createTicket = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const data: CreateTicketData = request.body;

    const ticket = await ticketService.createTicket(
        actor,
        data
    );

    response.status(201).json({
        data: ticket,
    });
};

const getTickets = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);

    const query: ListTicketsQuery =
        response.locals.validatedQuery;

    const result = await ticketService.getTickets(
        actor,
        query
    );

    response.status(200).json(result);
};

const getTicketById = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const ticket = await ticketService.getTicketById(
        actor,
        ticketId
    );

    response.status(200).json({
        data: ticket,
    });
};

const updateTicket = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const data: UpdateTicketData = request.body;

    const ticket = await ticketService.updateTicket(
        actor,
        ticketId,
        data
    );

    response.status(200).json({
        data: ticket,
    });
};

const assignTicket = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const data: AssignTicketData = request.body;

    const ticket = await ticketService.assignTicket(
        actor,
        ticketId,
        data
    );

    response.status(200).json({
        data: ticket,
    });
};

const updateTicketStatus = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);
    const ticketId = getTicketId(request);

    const data: UpdateTicketStatusData = request.body;

    const ticket =
        await ticketService.updateTicketStatus(
            actor,
            ticketId,
            data
        );

    response.status(200).json({
        data: ticket,
    });
};

export {
    getActor,
    getTicketId,

    createTicket,
    getTickets,
    getTicketById,
    updateTicket,
    assignTicket,
    updateTicketStatus,
};