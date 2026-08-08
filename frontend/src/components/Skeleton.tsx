interface SkeletonProps {
  height: number;
  radius?: number;
}

export function Skeleton({ height, radius = 8 }: SkeletonProps) {
  return (
    <div
      aria-hidden
      style={{
        height,
        borderRadius: radius,
        background:
          "linear-gradient(90deg, var(--color-surface-soft) 25%, var(--color-surface-card) 50%, var(--color-surface-soft) 75%)",
        backgroundSize: "200% 100%",
        animation: "lx-shimmer 1.4s ease infinite",
      }}
    />
  );
}
