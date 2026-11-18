import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    createCommentSchema,
} from "../../../../../src/features/tickets/comments/comment.schema.js";

describe("Comment Validation Schema", () => {
    it("should accept valid comment content", () => {
        expect(
            createCommentSchema.parse({
                content: "Valid comment",
            })
        ).toEqual({
            content: "Valid comment",
        });
    });

    it("should trim surrounding whitespace", () => {
        expect(
            createCommentSchema.parse({
                content: "  Valid comment \n",
            })
        ).toEqual({
            content: "Valid comment",
        });
    });

    it("should preserve internal whitespace and line breaks", () => {
        const content = "First line\nSecond line";

        expect(
            createCommentSchema.parse({ content })
        ).toEqual({ content });
    });

    it.each([
        "",
        " ",
        "\t\n",
        null,
        undefined,
        123,
        true,
        {},
        [],
        "Invalid\0content",
    ])("should reject invalid content: %j", (content) => {
        expect(
            createCommentSchema.safeParse({
                content,
            }).success
        ).toBe(false);
    });

    it("should reject missing content", () => {
        expect(
            createCommentSchema.safeParse({}).success
        ).toBe(false);
    });

    it.each([1, 4999, 5000])(
        "should accept content containing %i characters",
        (length) => {
            expect(
                createCommentSchema.safeParse({
                    content: "a".repeat(length),
                }).success
            ).toBe(true);
        }
    );

    it("should reject content exceeding 5000 characters", () => {
        expect(
            createCommentSchema.safeParse({
                content: "a".repeat(5001),
            }).success
        ).toBe(false);
    });

    it.each([
        { id: randomUUID() },
        { authorId: randomUUID() },
        { ticketId: randomUUID() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { private: true },
        { unsupported: "value" },
    ])("should reject unsupported fields: %j", (fields) => {
        expect(
            createCommentSchema.safeParse({
                content: "Valid comment",
                ...fields,
            }).success
        ).toBe(false);
    });

    it.each([
        "",
        " ",
        "\t\n",
        null,
        undefined,
        123,
        true,
        {},
        [],
        "Invalid\0content",
    ].map((content) => [content] as const))(
        "should reject invalid content: %j",
        (content) => {
            expect(
                createCommentSchema.safeParse({
                    content,
                }).success
            ).toBe(false);
        }
    );
});