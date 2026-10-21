import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { departments } from "./db/schema/index.js";

async function main() {
  let createdDepartmentId: number | undefined;

  try {
    console.log("Performing CRUD operations...");

    const [newDepartment] = await db
        .insert(departments)
        .values({
          code: `CS-${Date.now()}`,
          name: "Computer Science",
          description: "Computer Science Department",
        })
        .returning();

    if (!newDepartment) {
      throw new Error("Failed to create department");
    }

    createdDepartmentId = newDepartment.id;
    console.log("CREATE:", newDepartment);

    const [foundDepartment] = await db
        .select()
        .from(departments)
        .where(eq(departments.id, newDepartment.id));

    if (!foundDepartment) {
      throw new Error("Failed to read department");
    }

    console.log("READ:", foundDepartment);

    const [updatedDepartment] = await db
        .update(departments)
        .set({ name: "Software Engineering" })
        .where(eq(departments.id, newDepartment.id))
        .returning();

    if (!updatedDepartment) {
      throw new Error("Failed to update department");
    }

    console.log("UPDATE:", updatedDepartment);

    await db
        .delete(departments)
        .where(eq(departments.id, newDepartment.id));

    createdDepartmentId = undefined;
    console.log("DELETE: Department deleted.");
    console.log("CRUD operations completed successfully.");
  } finally {
    if (createdDepartmentId !== undefined) {
      await db
          .delete(departments)
          .where(eq(departments.id, createdDepartmentId));
    }
  }
}

main().catch((error: unknown) => {
  console.error("Error performing CRUD operations:", error);
  process.exitCode = 1;
});
