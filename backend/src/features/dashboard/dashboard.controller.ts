import type {
    Request,
    Response,
} from "express";

import {
    getActor,
} from "../tickets/ticket.controller.js";

import * as dashboardService from "./dashboard.service.js";

const getDashboardStats = async (
    request: Request,
    response: Response
) => {
    const actor = getActor(request);

    const stats =
        await dashboardService.getDashboardStats(actor);

    response.status(200).json({
        data: stats,
    });
};

export { getDashboardStats };