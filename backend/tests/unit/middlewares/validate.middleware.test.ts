import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";

import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { validate } from "../../../src/middlewares/validate.middleware.js";

describe("Validation Middleware", () => {
    const schema = z.object({
        name: z.string().trim().toUpperCase(),
    });

    const createMocks = (body: unknown, params: unknown = {}) => {
        const request = {
            body,
            params,
        } as Request;

        const response = {} as Response;
        const next = vi.fn() as NextFunction;

        return { request, response, next };
    };

    it("should validate request body successfully", () => {
        const { request, response, next } = createMocks({
            name: "Test",
        });

        validate(schema)(request, response, next);

        expect(next).toHaveBeenCalledOnce();
    });

    it("should apply Zod transformations to request body", () => {
        const { request, response, next } = createMocks({
            name: "  manager  ",
        });

        validate(schema)(request, response, next);

        expect(request.body).toEqual({
            name: "MANAGER",
        });

        expect(next).toHaveBeenCalledOnce();
    });

    it("should throw ZodError for invalid request body", () => {
        const { request, response, next } = createMocks({
            name: 123,
        });

        expect(() =>
            validate(schema)(request, response, next)
        ).toThrow(ZodError);

        expect(next).not.toHaveBeenCalled();
    });

    it("should validate route parameters", () => {
        const paramsSchema = z.object({
            roleId: z.uuid(),
        });

        const { request, response, next } = createMocks(
            {},
            { roleId: "550e8400-e29b-41d4-a716-446655440000" }
        );

        validate(paramsSchema, "params")(request, response, next);

        expect(next).toHaveBeenCalledOnce();
    });

    it("should reject invalid route parameters", () => {
        const paramsSchema = z.object({
            roleId: z.uuid(),
        });

        const { request, response, next } = createMocks(
            {},
            { roleId: "invalid-uuid" }
        );

        expect(() =>
            validate(paramsSchema, "params")(request, response, next)
        ).toThrow(ZodError);

        expect(next).not.toHaveBeenCalled();
    });
});

describe("Query Validation Middleware", () => {
    const schema = z.strictObject({
        page: z.string()
            .transform(Number)
            .pipe(z.number().int().positive()),

        search: z.string().trim().optional(),
    });

    it("should store transformed query values in response.locals", () => {
        const rawQuery = Object.freeze({
            page: "2",
            search: "  application  ",
        });

        const request = {
            get query() {
                return rawQuery;
            },
        } as unknown as Request;

        const response = {
            locals: {},
        } as Response;

        const next = vi.fn();

        validate(schema, "query")(
            request,
            response,
            next
        );

        expect(response.locals.validatedQuery).toEqual({
            page: 2,
            search: "application",
        });

        expect(next).toHaveBeenCalledOnce();
    });

    it("should preserve the original read-only request query", () => {
        const rawQuery = Object.freeze({
            page: "3",
        });

        const request = {
            get query() {
                return rawQuery;
            },
        } as unknown as Request;

        const response = {
            locals: {},
        } as Response;

        const next = vi.fn();

        validate(schema, "query")(
            request,
            response,
            next
        );

        expect(request.query).toBe(rawQuery);

        expect(request.query).toEqual({
            page: "3",
        });
    });

    it.each([
        { page: "0" },
        { page: "-1" },
        { page: "1.5" },
        { page: "invalid" },
        { page: ["1", "2"] },
        { page: "1", unexpected: "value" },
    ])("should reject invalid query input before forwarding", (query) => {
        const request = {
            query,
        } as unknown as Request;

        const response = {
            locals: {},
        } as Response;

        const next = vi.fn();

        expect(() =>
            validate(schema, "query")(
                request,
                response,
                next
            )
        ).toThrow(ZodError);

        expect(next).not.toHaveBeenCalled();

        expect(
            response.locals.validatedQuery
        ).toBeUndefined();
    });
});