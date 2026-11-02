"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createProjectAction, type CreateProjectState } from "./actions";

const initialState: CreateProjectState = { status: "idle" };

export function CreateProjectDialog({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createProjectAction, initialState);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="md" disabled={disabled}>
          <Plus className="h-4 w-4" />
          New project
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            A project holds one or more source videos. Files stay on disk; only metadata is stored
            in MySQL.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="name" className="label">
              Project name
            </label>
            <Input
              id="name"
              name="name"
              placeholder="Reel campaign - November"
              autoComplete="off"
              required
              minLength={2}
              maxLength={200}
              autoFocus
            />
          </div>

          {state.status === "error" ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {state.message}
            </p>
          ) : null}

          {state.status === "success" ? (
            <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">
              {state.message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
