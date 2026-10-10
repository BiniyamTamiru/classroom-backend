import { integer, pgTable, varchar, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";


const timeStamps = {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
};

export const departments = pgTable("departments", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    code: varchar("code", { length: 50 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 255 }),
    ...timeStamps,
});

export const subjects = pgTable("subjects", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    departmentId: integer("department_id")
        .notNull()
        .references(() => departments.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 50 }).notNull(),
    description: varchar("description", { length: 255 }),
    ...timeStamps,
});

export const departmentRelations = relations(departments, ({ many }) => ({
    subjects: many(subjects),
}));

export const subjectRelations = relations(subjects, ({ one }) => ({
    department: one(departments, {
        fields: [subjects.departmentId],
        references: [departments.id],
    }),
}));

export type department = typeof departments.$inferSelect;
export type newDepartment = typeof departments.$inferInsert;

export type subject = typeof subjects.$inferSelect;
export type newSubject = typeof subjects.$inferInsert;