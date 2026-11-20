import winston from "winston";

const { combine, timestamp, errors, json, colorize, simple } =
    winston.format;

const isProduction = process.env.NODE_ENV === "production";

const logger = winston.createLogger({
    level: isProduction ? "info" : "debug",

    format: combine(
        timestamp(),
        errors({ stack: true }),
        json()
    ),

    transports: [
        new winston.transports.Console({
            format: isProduction
                ? combine(timestamp(), errors({ stack: true }), json())
                : combine(colorize(), simple()),
        }),
    ],
});

if (!isProduction) {
    logger.add(
        new winston.transports.File({
            filename: "logs/error.log",
            level: "error",
        })
    );

    logger.add(
        new winston.transports.File({
            filename: "logs/combined.log",
        })
    );
}

export default logger;