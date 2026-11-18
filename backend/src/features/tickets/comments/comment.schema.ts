import { z } from "zod";

const createCommentSchema = z.strictObject({
    content: z
        .string()
        .trim()
        .min(1)
        .max(5000)
        .refine(
            (value) => !value.includes("\0"),
            {
                message: "Invalid comment characters",
            }
        ),
});

type CreateCommentData = z.infer<
    typeof createCommentSchema
>;

export {
    createCommentSchema,
};

export type {
    CreateCommentData,
};