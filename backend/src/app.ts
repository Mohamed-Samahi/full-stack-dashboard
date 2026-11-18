import express from "express";
import cookieParser from "cookie-parser";

import authRouter from "./features/auth/auth.route.js";
import rbacRouter from "./features/rbac/rbac.route.js";

import { errorHandler } from "./middlewares/error.middleware.js";

import { AppError } from "./errors/AppError.js";

const app = express();

// Global middleware
app.use(express.json());
app.use(cookieParser());

// Routes

// Authentication routes
app.use("/api/v1/auth", authRouter);

// RBAC routes
app.use("/api/v1/rbac", rbacRouter);

app.use((_request, _response) => {
    throw new AppError("Not found", 404);
});

// Global error handler
// IMPORTANT: Must be registered after the routes
app.use(errorHandler);

export default app;