import type { PropsWithChildren } from "react";
import { Link } from "@tanstack/react-router";
import { Icon } from "@iconify/react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { IS_TAURI } from "@/lib/env";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Overview", to: "/", icon: "fluent:grid-24-regular" },
  { label: "Accounts", to: "/accounts", icon: "fluent:people-team-24-regular" },
  { label: "Device status", to: "/device-status", icon: "fluent:phone-desktop-24-regular" },
];

function DesktopNav() {
  return (
    <nav className="hidden min-w-0 flex-1 items-center justify-center gap-2 lg:flex">
      {navItems.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "rounded-full px-3")}
          activeProps={{
            className: cn(buttonVariants({ variant: "secondary", size: "sm" }), "rounded-full px-3"),
          }}
          activeOptions={{ exact: item.to === "/" }}
        >
          <Icon icon={item.icon} data-icon="inline-start" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function MobileNav() {
  return (
    <div className="border-t border-dashed border-border/80 lg:hidden">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 overflow-x-auto px-20 py-2 scrollbar-none max-2xl:px-16 max-xl:px-10 max-lg:px-6 max-md:px-4">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "rounded-full px-3")}
            activeProps={{
              className: cn(buttonVariants({ variant: "secondary", size: "sm" }), "rounded-full px-3"),
            }}
            activeOptions={{ exact: item.to === "/" }}
          >
            <Icon icon={item.icon} data-icon="inline-start" />
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header
        className="sticky top-0 z-30 border-b border-dashed border-border bg-background/95 backdrop-blur"
        {...(IS_TAURI ? { "data-tauri-drag-region": true } : {})}
      >
        <div
          className={cn(
            "mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-20 max-2xl:px-16 max-xl:px-10 max-lg:px-6 max-md:px-4",
            IS_TAURI && "!pl-[5.5rem]",
          )}
        >
          <Link to="/" className="flex shrink-0 items-center gap-3" activeOptions={{ exact: true }}>
            <div className="hidden min-w-0 sm:block">
              <div className="truncate text-sm font-medium tracking-tight">codex-usage-dashboard</div>
              <div className="truncate text-xs text-muted-foreground">
                Multi-account Codex usage and switching
              </div>
            </div>
          </Link>

          <DesktopNav />

          <div className="ml-auto flex items-center gap-2">
            {!IS_TAURI && (
              <>
                <div className="hidden items-center gap-1.5 rounded-full border border-dashed border-border/60 bg-muted/20 px-2.5 py-1 text-xs text-muted-foreground md:flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  <span>Alpha</span>
                  <span className="text-border/60">·</span>
                  <span>Loopback guarded</span>
                </div>
                <Badge variant="warning" className="hidden sm:inline-flex">
                  Localhost only
                </Badge>
              </>
            )}
            {IS_TAURI && (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                Desktop
              </Badge>
            )}
            <ThemeToggle />
          </div>
        </div>

        <MobileNav />
      </header>

      <main className="mx-auto max-w-[1600px] px-20 pb-20 pt-8 max-2xl:px-16 max-xl:px-10 max-lg:px-6 max-md:px-4">
        {children}
      </main>
    </div>
  );
}
