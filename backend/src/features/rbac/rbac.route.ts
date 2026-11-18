import express from "express";

import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { authenticate } from "../../middlewares/auth.middleware.js";
import { authorize } from "../../middlewares/authorize.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";

import { AppError } from "../../errors/AppError.js";

import {
    getAllPermissions,
    getAllRoles,
    assignRoleToUser,
    getAllUsers,
} from "./rbac.controller.js";

import {
    assignUserRoleSchema,
    userParamsSchema,
} from "./rbac.schema.js";

import { PERMISSIONS } from "./rbac.constants.js";

const router = express.Router();

const requireAdmin = (
    request: Request,
    _response: Response,
    next: NextFunction
) => {
    if (!request.user) {
        throw new AppError("Authentication required", 401);
    }

    if (request.user.role !== "ADMIN") {
        throw new AppError("Forbidden", 403);
    }

    next();
};

const adminAccess = [
    authenticate,
    requireAdmin,
];

router.get(
    "/permissions",
    ...adminAccess,
    authorize(PERMISSIONS.PERMISSION_READ),
    getAllPermissions
);

router.get(
    "/roles",
    ...adminAccess,
    authorize(PERMISSIONS.ROLE_READ),
    getAllRoles
);

router.get(
    "/users",
    ...adminAccess,
    authorize(PERMISSIONS.USER_READ),
    getAllUsers
);

router.patch(
    "/users/:userId/role",
    ...adminAccess,
    authorize(PERMISSIONS.USER_UPDATE),
    validate(userParamsSchema, "params"),
    validate(assignUserRoleSchema),
    assignRoleToUser
);

// Unsupported RBAC routes return the shared JSON error format.
router.use((_request, _response) => {
    throw new AppError("Not found", 404);
});

export default router;