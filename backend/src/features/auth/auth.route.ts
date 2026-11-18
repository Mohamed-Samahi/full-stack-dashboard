import express from "express";

import {
    getMe,
    googleCallback,
    googleLogin,
    login,
    logout,
    refresh,
    register,
    changePassword,
} from "./auth.controller.js";

import {
    changePasswordSchema,
    loginSchema,
    registerSchema,
} from "./auth.schema.js";

import { validate } from "../../middlewares/validate.middleware.js";
import { authenticate } from "../../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/register", validate(registerSchema), register);

router.post("/login", validate(loginSchema), login);

router.get("/google", googleLogin);

router.get("/google/callback", googleCallback);

router.post("/refresh", refresh);

router.get("/me", authenticate, getMe);

router.post("/logout", logout);

router.patch(
    "/change-password",
    authenticate,
    validate(changePasswordSchema),
    changePassword
);

export default router;