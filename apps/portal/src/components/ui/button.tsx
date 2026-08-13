import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "bg-lime-300 px-5 py-3 text-stone-950 shadow-[0_10px_35px_rgba(190,242,100,.16)] hover:-translate-y-0.5 hover:bg-lime-200",
        secondary:
          "border border-white/12 bg-white/[.06] px-5 py-3 text-stone-100 hover:border-white/20 hover:bg-white/[.1]",
        ghost: "px-3 py-2 text-stone-300 hover:bg-white/[.06] hover:text-white",
      },
      size: {
        default: "h-11",
        sm: "h-9 px-4 py-2 text-xs",
        lg: "h-13 px-6 py-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
