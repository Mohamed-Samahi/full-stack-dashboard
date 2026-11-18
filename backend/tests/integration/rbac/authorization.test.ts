import { describe, expect, it } from "vitest";

import { api } from "../../helpers/api.helper.js";

import {
    loginTestUser,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/rbac/users";

describe("RBAC Authorization", () => {
    setupIntegrationTests();

    it("should reject unauthenticated requests", async () => {
        await api
            .get(endpoint)
            .expect(401);
    });

    it("should reject ADMIN without the required permission", async () => {
        const { accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: [],
        });

        const response = await api
            .get(endpoint)
            .set(withAuth(accessToken))
            .expect(403);

        expect(response.body).toMatchObject({
            status: "error",
            message: "Forbidden",
        });
    });

    it.each(["EMPLOYEE", "USER"])(
        "should reject %s even with legacy user:read permission",
        async (role) => {
            const { accessToken } = await loginTestUser({
                role,
                permissions: ["user:read"],
            });

            const response = await api
                .get(endpoint)
                .set(withAuth(accessToken))
                .expect(403);

            expect(response.body).toMatchObject({
                status: "error",
                message: "Forbidden",
            });
        }
    );

    it("should allow ADMIN with the required permission", async () => {
        const { user, accessToken } = await loginTestUser({
            role: "ADMIN",
            permissions: ["user:read"],
        });

        const response = await api
            .get(endpoint)
            .set(withAuth(accessToken))
            .expect(200);

        expect(response.body.data).toEqual([
            {
                id: user.id,
                name: user.name,
                email: user.email,
                role: {
                    id: user.role.id,
                    name: "ADMIN",
                },
                createdAt: expect.any(String),
            },
        ]);
    });
});