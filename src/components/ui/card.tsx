import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const cardVariants = cva(
  "text-card-foreground flex flex-col",
  {
    variants: {
      variant: {
        default: "bg-muted shadow-sm",
        "border-only": "border-2",
        "border-with-background": "bg-muted dark:bg-muted/30 border-2 border dark:border-border/50",
        "striped": "bg-striped-pattern border border-border",
        "double-border": "bg-muted border-2 border-border"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
)

interface CardProps
  extends React.ComponentProps<"div">,
  VariantProps<typeof cardVariants> {
  gap?: number;
  noPadding?: boolean;
}

function Card({ className, variant, gap = 1, noPadding = false, children, ...props }: CardProps) {

  // Children'ı kontrol et - CardHeader ve CardFooter var mı?
  const childrenArray = React.Children.toArray(children);
  const headerChild = childrenArray.find(
    child => React.isValidElement(child) && child.type === CardHeader
  );
  const footerChild = childrenArray.find(
    child => React.isValidElement(child) && child.type === CardFooter
  );

  const otherChildren = childrenArray.filter(
    child => !(React.isValidElement(child) && (child.type === CardHeader || child.type === CardFooter))
  );

  // Inner card radius - sabit
  const innerRadiusPx = 12;

  // Gap'e göre outer/inner arası padding
  const gapPaddingPx = gap * 4; // gap değerini pixel'e çevir

  // Outer radius = inner radius + gap padding
  const outerRadiusPx = innerRadiusPx + gapPaddingPx;

  // Inner card'ın kendi padding'i - noPadding varsa 0, yoksa 24px
  const innerPaddingPx = noPadding ? 0 : 24; // p-6 = 24px
  const innerMarginTop = headerChild ? gapPaddingPx : 0;
  const innerMarginBottom = footerChild ? gapPaddingPx : 0;
  
  // Inner card style'ları (header/footer varsa padding yok)
  const innerStyle: React.CSSProperties = headerChild || footerChild ? {
    borderRadius: `${innerRadiusPx}px`,
    marginTop: innerMarginTop,
    marginBottom: innerMarginBottom
  } : {
    padding: `${innerPaddingPx}px`,
    borderRadius: `${innerRadiusPx}px`,
    marginTop: innerMarginTop,
    marginBottom: innerMarginBottom
  };

  // Inner card border for specific variants
  const innerCardBorderClass = 
    variant === "striped" ? "border border-border" :
    variant === "double-border" ? (headerChild ? "border-t-2 border-border" : "") + (footerChild ? " border-b-2 border-border" : "") :
    "";

  // Header ve Footer yoksa normal card
  if (!headerChild && !footerChild) {
    const outerStyle: React.CSSProperties = {
      padding: `${gapPaddingPx}px`,
      borderRadius: `${outerRadiusPx}px`
    };

    return (
      <div
        className={cn(cardVariants({ variant }), className)}
        style={outerStyle}
        {...props}
      >
        <div
          className={cn("bg-card relative overflow-hidden flex flex-col flex-1", innerCardBorderClass)}
          style={innerStyle}
        >
          {children}
        </div>
      </div>
    );
  }

  // Header veya Footer varsa özel layout
  const outerStyleWithHeaderFooter: React.CSSProperties = {
    padding: `${gapPaddingPx}px`,
    borderRadius: `${outerRadiusPx}px`
  };


  return (
    <div
      className={cn(cardVariants({ variant }), "flex flex-col h-full", className)}
      style={outerStyleWithHeaderFooter}
      {...props}
    >
      {/* Header alanı - outer card'da, full width */}
      {headerChild && <div className="shrink-0">{headerChild}</div>}

      {/* Inner card - body content */}
      <div
        className={cn("bg-card flex-1 flex flex-col relative overflow-hidden", innerCardBorderClass)}
        style={innerStyle}
      >
        {otherChildren}
      </div>

      {/* Footer alanı - outer card'da, full width */}
      {footerChild && <div className="shrink-0">{footerChild}</div>}
    </div>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col p-4",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(className, "p-4")}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-3 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  cardVariants,
  type CardProps,
}
