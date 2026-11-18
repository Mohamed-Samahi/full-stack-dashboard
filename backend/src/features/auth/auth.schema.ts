import { z } from "zod";

export const nameSchema = z.string()
    .trim()
    .min(2)
    .max(100);

const emailSchema = z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email());

const passwordSchema = z.string()
    .min(8)
    .refine(
        (password) =>
            Buffer.byteLength(password, "utf8") <= 72,
        "Password must not exceed 72 UTF-8 bytes"
    );

export const registerSchema = z.object({
    name: nameSchema.optional(),
    email: emailSchema,
    password: passwordSchema,
}).strict();

export const loginSchema = z.object({
    email: emailSchema,
    password: z.string().min(1),
});

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
}).strict().refine(
    (data) => data.currentPassword !== data.newPassword,
    {
        message: "New password must differ from current password",
        path: ["newPassword"],
    }
);

export const updateProfileSchema = z.object({
    name: nameSchema,
}).strict();

export type UpdateProfileData = z.infer<
    typeof updateProfileSchema
>;

export type ChangePasswordData = z.infer<
    typeof changePasswordSchema
>;

export type RegisterData = z.infer<typeof registerSchema>;

export type LoginData = z.infer<typeof loginSchema>;