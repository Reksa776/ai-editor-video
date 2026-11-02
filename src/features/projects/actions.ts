"use server";

import { revalidatePath } from "next/cache";
import { ulid } from "@/lib/id";
import { getPrisma } from "@/lib/prisma";

export type CreateProjectState = {
  status: "idle" | "error" | "success";
  message?: string;
};

export async function createProjectAction(
  _prevState: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";

  if (name.length < 2) {
    return { status: "error", message: "Project name must be at least 2 characters." };
  }
  if (name.length > 200) {
    return { status: "error", message: "Project name must be 200 characters or fewer." };
  }

  try {
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: { id: ulid(), name },
      select: { id: true },
    });

    revalidatePath("/");
    revalidatePath("/projects");
    revalidatePath(`/projects/${project.id}`);

    return { status: "success", message: `Project "${name}" created.` };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.split("\n")[0] : "Unknown database error";
    return {
      status: "error",
      message: `Could not create project: ${message}`,
    };
  }
}
