interface BadgeProps {
  className: string;
  children: React.ReactNode;
  small?: boolean;
}

export function Badge({ className, children, small }: BadgeProps) {
  return (
    <span
      className={`badge ${className}`}
      style={small ? { padding: "2px 8px", fontSize: 11 } : undefined}
    >
      <span className="badge-dot" />
      {children}
    </span>
  );
}
