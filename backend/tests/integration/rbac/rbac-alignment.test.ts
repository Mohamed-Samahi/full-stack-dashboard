import { describe, expect, it } from "vitest";

import { api } from "../../helpers/api.helper.js";

import {
    loginTestUser,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import { prisma } from "../../../src/config/db.js";

const endpoint = "/api/v1/rbac";

describe("RBAC Alignment", () => {
    setupIntegrationTests();

    it("should return only predefined roles", async () => {
        const { accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: ["role:read", "role:create"],
        });

        await prisma.role.createMany({
            data: [
                { name: "EMPLOYEE" },
                { name: "USER" },
                { name: "CUSTOM" },
            ],
        });

        const response = await api
            .get(`${endpoint}/roles`)
            .set(withAuth(accessToken))
            .expect(200);

        expect(
            response.body.data.map(
                (role: { name: string }) => role.name
            )
        ).toEqual(["ADMIN", "EMPLOYEE", "USER"]);

        expect(response.body.data[0]).toEqual({
            id: expect.any(String),
            name: "ADMIN",
            permissions: [
                {
                    key: "role:read",
                    description: null,
                },
            ],
        });
    });

    it("should return only supported permissions", async () => {
        const { accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: ["permission:read"],
        });

        await prisma.permission.createMany({
            data: [
                { key: "ticket:create" },
                { key: "ticket:self-assign" },
                { key: "role:create" },
                { key: "role:delete" },
                { key: "user:create" },
                { key: "legacy:read" },
            ],
        });

        const response = await api
            .get(`${endpoint}/permissions`)
            .set(withAuth(accessToken))
            .expect(200);

        expect(response.body.data).toEqual([
            {
                id: expect.any(String),
                key: "permission:read",
                description: null,
            },
            {
                id: expect.any(String),
                key: "ticket:create",
                description: null,
            },
            {
                id: expect.any(String),
                key: "ticket:self-assign",
                description: null,
            },
        ]);
    });

    it.each(["EMPLOYEE", "USER", "CUSTOM"])(
        "should deny administrative operations to %s with legacy permissions",
        async (role) => {
            const { accessToken } = await loginTestUser({
                role,
                permissions: [
                    "role:read",
                    "permission:read",
                    "user:read",
                    "user:update",
                ],
            });

            const { user: target } = await createTestUser({
                role: "USER",
            });

            const adminRole = await prisma.role.create({
                data: { name: "ADMIN" },
            });

            for (const path of ["/roles", "/permissions"]) {
                await api
                    .get(`${endpoint}${path}`)
                    .set(withAuth(accessToken))
                    .expect(403);
            }

            // USER and EMPLOYEE listing access is already
            // covered in authorization.test.ts.
            if (role === "CUSTOM") {
                await api
                    .get(`${endpoint}/users`)
                    .set(withAuth(accessToken))
                    .expect(403);
            }

            await api
                .patch(`${endpoint}/users/${target.id}/role`)
                .set(withAuth(accessToken))
                .send({ roleId: adminRole.id })
                .expect(403);

            const unchanged = await prisma.user.findUniqueOrThrow({
                where: { id: target.id },
            });

            expect(unchanged.roleId).toBe(target.roleId);
            expect(unchanged.authVersion).toBe(target.authVersion);
        }
    );

    it("should require individual administrative permissions", async () => {
        const { accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: ["user:read"],
        });

        const { user: target } = await createTestUser({
            role: "USER",
        });

        await api
            .get(`${endpoint}/roles`)
            .set(withAuth(accessToken))
            .expect(403);

        await api
            .get(`${endpoint}/permissions`)
            .set(withAuth(accessToken))
            .expect(403);

        await api
            .patch(`${endpoint}/users/${target.id}/role`)
            .set(withAuth(accessToken))
            .send({ roleId: target.roleId })
            .expect(403);
    });

    it("should require authentication on remaining administrative routes", async () => {
        await api
            .get(`${endpoint}/roles`)
            .expect(401);

        await api
            .get(`${endpoint}/permissions`)
            .expect(401);

        const { user } = await createTestUser();

        await api
            .patch(`${endpoint}/users/${user.id}/role`)
            .send({ roleId: user.roleId })
            .expect(401);
    });

    it("should disable dynamic role-management endpoints", async () => {
        const { user, accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: [
                "role:create",
                "role:update",
                "role:delete",
            ],
        });

        const rolesBefore = await prisma.role.findMany({
            orderBy: { id: "asc" },
        });

        const mappingsBefore =
            await prisma.rolePermission.findMany({
                orderBy: [
                    { roleId: "asc" },
                    { permissionId: "asc" },
                ],
            });

        const createResponse = await api
            .post(`${endpoint}/roles`)
            .set(withAuth(accessToken))
            .send({
                name: "MANAGER",
                permissions: [],
            })
            .expect(404);

        const updateResponse = await api
            .patch(`${endpoint}/roles/${user.roleId}`)
            .set(withAuth(accessToken))
            .send({ name: "MANAGER" })
            .expect(404);

        const deleteResponse = await api
            .delete(`${endpoint}/roles/${user.roleId}`)
            .set(withAuth(accessToken))
            .expect(404);

        for (const response of [
            createResponse,
            updateResponse,
            deleteResponse,
        ]) {
            expect(response.body).toEqual({
                status: "error",
                message: "Not found",
            });
        }

        expect(await prisma.role.findMany({
            orderBy: { id: "asc" },
        })).toEqual(rolesBefore);

        expect(await prisma.rolePermission.findMany({
            orderBy: [
                { roleId: "asc" },
                { permissionId: "asc" },
            ],
        })).toEqual(mappingsBefore);
    });
});