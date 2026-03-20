import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "aria-invalid:border-2 file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 flex w-full min-w-0 bg-input/50 text-sm shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm caret-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive/60 [&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.5)] [&:-webkit-autofill]:[-webkit-text-fill-color:hsl(var(--foreground))] [&:-webkit-autofill:hover]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.5)] [&:-webkit-autofill:focus]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.5)] [&:-webkit-autofill:active]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.5)] dark:[&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.3)] dark:[&:-webkit-autofill:hover]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.3)] dark:[&:-webkit-autofill:focus]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.3)] dark:[&:-webkit-autofill:active]:shadow-[inset_0_0_0_1000px_hsl(var(--input)/0.3)] [&[type=number]]:appearance-textfield [&[type=number]::-webkit-outer-spin-button]:appearance-none [&[type=number]::-webkit-inner-spin-button]:appearance-none border-2 border-border/60",
  {
    variants: {
      size: {
        xs: "h-7 px-2 file:h-4 rounded-sm",
        sm: "h-8 px-3 file:h-5 rounded-md",
        md: "h-9 px-3 file:h-6 rounded-md",
        default: "h-10 px-3 file:h-7 rounded-md",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

export interface InputProps
  extends Omit<React.ComponentProps<"input">, "size">,
  VariantProps<typeof inputVariants> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(inputVariants({ size, className }))}
        {...props}
      />
    )
  }
)

Input.displayName = "Input"

export { Input }
