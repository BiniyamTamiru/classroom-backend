import { integer, index, pgEnum, pgTable, text, uniqueIndex, varchar, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { user } from "./auth.js";

const timeStamps = {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
};

export const classStatusEnum = pgEnum("class_status", ["active", "inactive", "archived"]);

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

    name: varchar("name", { length: 255 }).notNull(),

    description: varchar("description", { length: 255 }),

    ...timeStamps,
});

export const classes = pgTable(
    "classes",
    {
        id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

        subjectId: integer("subject_id")
            .notNull()
            .references(() => subjects.id, { onDelete: "cascade" }),

        teacherId: text("teacher_id")
            .notNull()
            .references(() => user.id, { onDelete: "restrict" }),

        inviteCode: varchar("invite_code", { length: 255 }).notNull(),

        name: varchar("name", { length: 255 }).notNull(),
        description: text("description"),

        capacity: integer("capacity").default(0), // Added capacity

        bannerUrl: text("banner_url"),
        bannerCldPubId: text("banner_cld_pub_id"), // Added Cloudinary Public ID column

        status: classStatusEnum("status").notNull().default("active"),

        ...timeStamps,
    },
    (table) => [
        uniqueIndex("classes_invite_code_unique").on(table.inviteCode),
        index("classes_subject_id_idx").on(table.subjectId),
        index("classes_teacher_id_idx").on(table.teacherId),
    ],
);

export const enrollments = pgTable(
    "enrollments",
    {
        id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

        studentId: text("student_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),

        classId: integer("class_id")
            .notNull()
            .references(() => classes.id, { onDelete: "cascade" }),

        ...timeStamps,
    },
    (table) => [
        uniqueIndex("enrollments_student_class_unique").on(table.studentId, table.classId),
        index("enrollments_student_id_idx").on(table.studentId),
        index("enrollments_class_id_idx").on(table.classId),
    ],
);


export const departmentRelations = relations(departments, ({ many }) => ({
    subjects: many(subjects),
}));


export const subjectRelations = relations(subjects, ({ one, many }) => ({
    department: one(departments, {
        fields: [subjects.departmentId],
        references: [departments.id],
    }),
    classes: many(classes),
}));

export const classRelations = relations(classes, ({ one, many }) => ({
    subject: one(subjects, {
        fields: [classes.subjectId],
        references: [subjects.id],
    }),
    teacher: one(user, {
        fields: [classes.teacherId],
        references: [user.id],
    }),
    enrollments: many(enrollments),
}));

export const enrollmentRelations = relations(enrollments, ({ one }) => ({
    student: one(user, {
        fields: [enrollments.studentId],
        references: [user.id],
    }),
    class: one(classes, {
        fields: [enrollments.classId],
        references: [classes.id],
    }),
}));

export const appUserRelations = relations(user, ({ many }) => ({
    taughtClasses: many(classes),
    enrollments: many(enrollments),
}));



export type department = typeof departments.$inferSelect;
export type newDepartment = typeof departments.$inferInsert;

export type subject = typeof subjects.$inferSelect;
export type newSubject = typeof subjects.$inferInsert;

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;