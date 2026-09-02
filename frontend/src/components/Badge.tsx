interface BadgeProps {
  className: string;
  children: React.ReactNode;
  small?: boolean;
  style?: React.CSSProperties;
}

export function Badge({ className, children, small, style }: BadgeProps) {
  return (
    <span
      className={`badge ${className}`}
      style={{
        ...(small ? { padding: "2px 8px", fontSize: 11 } : {}),
        ...style,
      }}
    >
      <span className="badge-dot" />
      {children}
    </span>
  );
}
