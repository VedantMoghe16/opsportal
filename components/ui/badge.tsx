import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        lime: "border-transparent bg-lime-soft text-[hsl(72_60%_22%)]",
        mint: "border-transparent bg-mint/40 text-[hsl(162_50%_22%)]",
        success:
          "border-transparent bg-[hsl(158_64%_42%/0.14)] text-[hsl(158_64%_28%)]",
        warning:
          "border-transparent bg-[hsl(38_92%_50%/0.16)] text-[hsl(32_80%_34%)]",
        danger:
          "border-transparent bg-[hsl(0_72%_56%/0.13)] text-[hsl(0_64%_42%)]",
        info: "border-transparent bg-[hsl(224_76%_58%/0.13)] text-[hsl(224_64%_44%)]",
        purple:
          "border-transparent bg-[hsl(265_70%_60%/0.13)] text-[hsl(265_56%_46%)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
