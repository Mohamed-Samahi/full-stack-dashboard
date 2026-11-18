import type {
    NextFunction,
    Request,
    Response,
} from "express";

import type {
    Prisma,
} from "../generated/prisma/client.js";

import { prisma } from "../config/db.js";
import { AppError } from "../errors/AppError.js";
import { verifyAccessToken } from "../utils/jwt.js";

type AuthenticatedActor = NonNullable<Request["user"]>;

const getBearerToken = (
    authorization: string | undefined
): string => {
    if (!authorization?.startsWith("Bearer ")) {
        throw new AppError("Authentication required", 401);
    }

    const token = authorization.split(" ")[1];

    if (!token) {
        throw new AppError("Authentication required", 401);
    }

    return token;
};

const authenticateAccessToken = async (
    token: string,
    database: Pick<Prisma.TransactionClient, "user"> = prisma
): Promise<AuthenticatedActor> => {
    let payload;

    try {
        payload = verifyAccessToken(token);
    } catch {
        throw new AppError("Invalid or expired token", 401);
    }

    if (
        typeof payload.userId !== "string" ||
        !payload.userId
    ) {
        throw new AppError("Invalid or revoked token", 401);
    }

    const user = await database.user.findUnique({
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

    return {
        id: user.id,
        role: user.role.name,
        permissions: payload.permissions,
    };
};

const authenticate = async (
    request: Request,
    _response: Response,
    next: NextFunction
) => {
    const token = getBearerToken(
        request.headers.authorization
    );

    request.user = await authenticateAccessToken(token);

    next();
};

export {
    authenticate,
    authenticateAccessToken,
    getBearerToken,
};