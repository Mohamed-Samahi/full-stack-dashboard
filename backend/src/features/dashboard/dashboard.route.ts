import express from "express";

import {
    authenticate,
} from "../../middlewares/auth.middleware.js";

import {
    authorize,
} from "../../middlewares/authorize.middleware.js";

import {
    PERMISSIONS,
} from "../rbac/rbac.constants.js";

import {
    getDashboardStats,
} from "./dashboard.controller.js";

const router = express.Router();

router.get(
    "/stats",
    authenticate,
    authorize(PERMISSIONS.TICKET_READ),
    getDashboardStats
);

export default router;