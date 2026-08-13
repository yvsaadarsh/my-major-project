import { AlertCircle, Loader2 } from "lucide-react";

export function LoadingState({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="dark-grid grid min-h-screen place-items-center text-slate-100">
      <div className="flex items-center gap-3 rounded-3xl border border-white/10 bg-slate-950/70 px-5 py-4">
        <Loader2 className="animate-spin text-teal-300" size={18} />
        <span className="text-sm font-medium text-slate-300">{label}</span>
      </div>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/10 px-4 py-3 text-sm text-rose-100">
      <AlertCircle size={17} />
      {message}
    </div>
  );
}

export function EmptyState({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="rounded-[2rem] border border-dashed border-white/15 bg-white/[0.025] p-8 text-center">
      <p className="text-lg font-semibold text-white">{title}</p>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-400">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
