"use client";

import { FormEvent } from "react";
import { MessageSquare } from "lucide-react";

import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import type { Task } from "@/lib/ui/api-client";
import type { Role } from "@/lib/ui/permissions";

export function CommentsPanel({
  role,
  comments,
  comment,
  saving,
  onCommentChange,
  onAddComment,
}: {
  role: Role;
  comments: NonNullable<Task["comments"]> | undefined;
  comment: string;
  saving: boolean;
  onCommentChange: (value: string) => void;
  onAddComment: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <SectionCard>
      <h2 className="text-xl font-semibold text-white">Comments</h2>
      <div className="mt-5 space-y-4">
        {comments?.length ? (
          comments.map((item) => (
            <div
              key={item.id}
              className="rounded-3xl border border-white/10 bg-white/[0.035] p-4"
            >
              <p className="text-sm leading-6 text-slate-300">{item.body}</p>
              <p className="mt-3 text-xs text-slate-500">
                {item.author.name} · {new Date(item.createdAt).toLocaleString()}
              </p>
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">No comments yet.</p>
        )}
      </div>

      <form
        onSubmit={onAddComment}
        className="mt-8 rounded-3xl border border-white/10 bg-white/[0.035] p-4"
      >
        <div className="flex items-center gap-3">
          <MessageSquare className="text-teal-300" size={18} />
          <p className="text-sm font-semibold text-white">Add comment</p>
        </div>
        <textarea
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
          className="mt-4 min-h-28 w-full rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
          placeholder="Write a tenant-scoped note..."
        />
        <div className="mt-4">
          <PermissionAction
            role={role}
            permission="tasks:comment"
            variant="secondary"
            type="submit"
          >
            {saving ? "Saving..." : "Add comment"}
          </PermissionAction>
        </div>
      </form>
    </SectionCard>
  );
}
