import type {
    NextFunction,
    Request,
    Response,
} from "express";

import { prisma } from "../config/db.js";
import { AppError } from "../errors/AppError.js";
import { verifyAccessToken } from "../utils/jwt.js";

const authenticate = async (
    request: Request,
    _response: Response,
    next: NextFunction
) => {
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
        throw new AppError("Authentication required", 401);
    }

    const token = authorization.split(" ")[1];

    if (!token) {
        throw new AppError("Authentication required", 401);
    }

    let payload;

    try {
        payload = verifyAccessToken(token);
    } catch {
        throw new AppError("Invalid or expired token", 401);
    }

    if (typeof payload.userId !== "string" || !payload.userId) {
        throw new AppError("Invalid or revoked token", 401);
    }

    const user = await prisma.user.findUnique({
        where: {
            id: payload.userId,
        },
        select: {
            id: true,
            roleId: true,
            authVersion: true,
            role: {
                select: {
                    name: true,
                    authVersion: true,
                },
            },
        },
    });

    if (
        !user ||
        user.roleId !== payload.roleId ||
        user.authVersion !== payload.userVersion ||
        user.role.authVersion !== payload.roleVersion ||
        user.role.name !== payload.role ||
        !Array.isArray(payload.permissions) ||
        !payload.permissions.every(
            (permission) => typeof permission === "string"
        )
    ) {
        throw new AppError("Invalid or revoked token", 401);
    }

    request.user = {
        id: user.id,
        role: user.role.name,
        permissions: payload.permissions,
    };

    next();
};

export { authenticate };