import type { Request, Response, NextFunction } from "express";
import aj from "../config/arcjet.js";
import { type ArcjetNodeRequest, slidingWindow } from "@arcjet/node";

type RateLimitRole = "admin" | "teacher" | "student" | "guest";

const security_Middleware = async (
    req: Request,
    res: Response,
    next: NextFunction

) => {
    if (process.env.NODE_ENV === "test") {
        return next();
    }


    try {
        const role: RateLimitRole = req.user?.role ?? "guest";

        let limit: number;
        let message: string;

        switch (role) {
            case "admin":
                limit = 20;
                message = "Admin request limit exceeded (20 per minute).";
                break;

            case "teacher":
            case "student":
                limit = 10;
                message =
                    "User request limit exceeded (10 per minute). Please wait.";
                break;

            default:
                limit = 5;
                message =
                    "Guest request limit exceeded (5 per minute). Please sign up for higher limits.";
                break;
        }

        const client = aj.withRule(
            slidingWindow({
                mode: "LIVE",
                interval: "1m",
                max: limit,
            })
        );

        const arcjetRequest: ArcjetNodeRequest = {
            headers: req.headers,
            method: req.method,
            url: req.originalUrl || req.url,
            socket: {
                remoteAddress:
                    req.socket.remoteAddress ?? req.ip ?? "0.0.0.0",
            },
        };

        // Evaluate the request with Arcjet
        const decision = await client.protect(arcjetRequest);

        // TEMPORARY DEBUG LOGS
        console.log("Arcjet conclusion:", decision.conclusion);
        console.log("Arcjet reason:", decision.reason);

        for (const result of decision.results) {
            console.log({
                conclusion: result.conclusion,
                state: result.state,
                reason: result.reason,
            });
        }

        // Do not continue when Arcjet evaluation fails
        if (decision.isErrored()) {
            console.error("Arcjet decision error:", decision.reason);

            return res.status(503).json({
                error: "security_service_unavailable",
                message:
                    "Security verification is temporarily unavailable.",
            });
        }

        // Block requests identified as disallowed bots
        if (decision.isDenied() && decision.reason.isBot()) {
            return res.status(403).json({
                error: "forbidden",
                message: "Automated requests are not allowed.",
            });
        }

        // Block requests denied by Shield
        if (decision.isDenied() && decision.reason.isShield()) {
            return res.status(403).json({
                error: "forbidden",
                message: "Request blocked by security policy.",
            });
        }

        // Block requests that exceed the rate limit
        if (decision.isDenied() && decision.reason.isRateLimit()) {
            return res.status(429).json({
                error: "too_many_requests",
                message,
            });
        }

        // Block any other denied request
        if (decision.isDenied()) {
            return res.status(403).json({
                error: "forbidden",
                message: "Request blocked.",
            });
        }

        // Allow the request to continue
        return next();
    } catch (error) {
        console.error("Arcjet middleware error:", error);

        return res.status(503).json({
            error: "security_service_unavailable",
            message: "Security verification is temporarily unavailable.",
        });
    }
};

export default security_Middleware;