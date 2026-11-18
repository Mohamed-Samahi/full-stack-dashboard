import "dotenv/config";

import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "../src/config/db.js";
import { AppError } from "../src/errors/AppError.js";

import {
    lockRbacConfiguration,
} from "../src/features/rbac/rbac.lock.js";

const credentialsSchema = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),

    password: z.string()
        .min(12)
        .refine(
            (password) =>
                Buffer.byteLength(password, "utf8") <= 72,
            "Password must not exceed 72 UTF-8 bytes"
        ),
});

const main = async () => {
    const credentials = credentialsSchema.safeParse({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
    });

    if (!credentials.success) {
        throw new AppError(
            "Provide a valid ADMIN_EMAIL and an ADMIN_PASSWORD "
            + "of at least 12 characters and at most 72 UTF-8 bytes",
            400
        );
    }

    const { email, password } = credentials.data;

    const result = await prisma.$transaction(async (tx) => {
        await lockRbacConfiguration(tx);

        const adminRole = await tx.role.findUnique({
            where: {
                name: "ADMIN",
            },
            select: {
                id: true,
            },
        });

        if (!adminRole) {
            throw new AppError(
                "ADMIN role is not configured. Run RBAC seeding first.",
                409
            );
        }

        const existingUsers = await tx.user.findMany({
            where: {
                email: {
                    equals: email,
                    mode: "insensitive",
                },
            },
            select: {
                id: true,
                roleId: true,
                password: true,
            },
            take: 2,
        });

        if (existingUsers.length > 1) {
            throw new AppError(
                "Conflicting email records exist",
                409
            );
        }

        const existingUser = existingUsers[0];

        if (existingUser) {
            // Never silently promote an existing account.
            if (existingUser.roleId !== adminRole.id) {
                throw new AppError(
                    "An account with this email already exists "
                    + "and is not an administrator",
                    409
                );
            }

            // Never silently reset an existing ADMIN password.
            if (
                !existingUser.password ||
                !(await bcrypt.compare(
                    password,
                    existingUser.password
                ))
            ) {
                throw new AppError(
                    "Existing administrator credentials do not match",
                    409
                );
            }

            return "existing";
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await tx.user.create({
            data: {
                email,
                password: hashedPassword,
                name: "Administrator",
                roleId: adminRole.id,
            },
            select: {
                id: true,
            },
        });

        return "created";
    }, {
        maxWait: 10000,
        timeout: 15000,
    });

    console.log(
        result === "created"
            ? "Administrator provisioned successfully."
            : "Administrator already provisioned. No changes made."
    );
};

main()
    .catch((error: unknown) => {
        console.error(
            error instanceof AppError
                ? error.message
                : "Administrator provisioning failed."
        );

        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });