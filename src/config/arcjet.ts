import arcjet, { shield, detectBot, slidingWindow } from "@arcjet/node";

if (!process.env.ARCJET_KEY && process.env.NODE_ENV !== "test") {
    throw new Error("ARCJET_KEY env is required");
}

const aj = arcjet({
    key: process.env.ARCJET_KEY!,
    rules: [
        // Shield protects your app from common attacks such as SQL injection
        shield({ mode: "LIVE" }),

        // Create a bot detection rule
        detectBot({
            mode: "LIVE", // Blocks requests. Use "DRY_RUN" to log only
            // Block all bots except the following
            allow: [
                "CATEGORY:SEARCH_ENGINE", // Google, Bing, etc.
                // "CATEGORY:MONITOR", // Uptime monitoring services
                // "CATEGORY:PREVIEW", // Link previews such as Slack, Discord
            ],
        }),

        // Rate limit: maximum 5 requests per 2 seconds

        slidingWindow({
            mode: "LIVE",
            interval: "100s",
            max: process.env.NODE_ENV === "production" ? 5 : 100,
        }),
    ],
});

export default aj;