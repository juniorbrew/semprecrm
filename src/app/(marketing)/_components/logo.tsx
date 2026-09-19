import Link from "next/link";

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`font-heading text-xl font-semibold tracking-tight text-foreground ${className ?? ""}`}
    >
      Sempre<span className="text-primary">CRM</span>
    </Link>
  );
}
