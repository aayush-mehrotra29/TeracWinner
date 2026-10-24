"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type TextShimmerProps = React.HTMLAttributes<HTMLSpanElement> & {
  spread?: number;
  invertLight?: boolean;
  disableShimmer?: boolean;
};

/** A text-only loading treatment; the text remains in the accessibility tree. */
export function TextShimmer({
  children,
  className,
  style,
  spread = 10,
  invertLight = false,
  disableShimmer = false,
  ...props
}: TextShimmerProps) {
  const safeSpread = Number.isFinite(spread) ? Math.max(1, Math.min(spread, 40)) : 10;
  const base = invertLight ? "#858585" : "#707070";
  const highlight = invertLight ? "#262626" : "#fafafa";

  return (
    <span
      data-shimmer={disableShimmer ? "false" : "true"}
      className={cn(!disableShimmer && "cot-text-shimmer", className)}
      style={
        disableShimmer
          ? style
          : {
              backgroundImage: `linear-gradient(110deg, ${base} 0%, ${base} ${50 - safeSpread}%, ${highlight} 50%, ${base} ${50 + safeSpread}%, ${base} 100%)`,
              backgroundSize: "250% 100%",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              color: "transparent",
              ...style,
            }
      }
      {...props}
    >
      {children}
    </span>
  );
}
