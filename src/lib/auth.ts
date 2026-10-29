import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from "../db/schema/auth.js";


export const auth = betterAuth({
     secret: process.env.BETER_AUTH_SECRET,

      trustedOrigins: [process.env.FRONTEND_URL!],
    database: drizzleAdapter(db, {
        provider: "pg",
        schema
    }),
    emailAndPassword:{
        enabled:true
    },
    user: {
        additionalFields: {
            role: {
                type: "string",
                required: true,
                defaultValue: "student",
                input: true,
            },
            imageCldpubId: {
                type: "string",
                required: false,
                input: true,
            },
        },
    },
});