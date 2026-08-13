type SectionCardProps = {
  children: React.ReactNode;
  className?: string;
};

export function SectionCard({ children, className = "" }: SectionCardProps) {
  return (
    <section
      className={`rounded-[2rem] border border-white/10 bg-slate-950/55 p-5 soft-border backdrop-blur-xl transition-all duration-300 hover:border-white/15 ${className}`}
    >
      {children}
    </section>
  );
}
