import * as React from "react";
import { cn } from "../lib/utils";

export interface LogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Show only the icon part of the logo */
  iconOnly?: boolean;
}

/**
 * Unitfield logo component that automatically switches between light/dark versions.
 *
 * Uses CSS-based theme detection (`dark:` Tailwind variant) instead of JS state so
 * that the correct logo is shown from the very first paint — even on SSR/refresh.
 * `PreventFlashOnWrongTheme` (remix-themes) already sets `<html class="dark">` via
 * an inline script before any React hydration, so the Tailwind dark: classes resolve
 * immediately without a flash.
 *
 * @param {boolean} iconOnly - Show only the logogram icon
 * @param {string} className - Additional CSS classes
 */
export function Logo({ className, iconOnly = false, ...rest }: LogoProps) {
  if (iconOnly) {
    return (
      <>
        {/* Shown in light mode */}
        <img
          src="/logos/logogram-without-tm.svg"
          alt="Unitfield"
          className={cn("h-8 w-auto block dark:hidden", className)}
          aria-hidden="true"
          {...rest}
        />
        {/* Shown in dark mode */}
        <img
          src="/logos/logogram-without-tm-white.svg"
          alt="Unitfield"
          className={cn("h-8 w-auto hidden dark:block", className)}
          {...rest}
        />
      </>
    );
  }

  return (
    <>
      {/* Shown in light mode */}
      <img
        src="/logos/logo-full.svg"
        alt="Unitfield"
        className={cn("h-8 w-auto block dark:hidden", className)}
        aria-hidden="true"
        {...rest}
      />
      {/* Shown in dark mode */}
      <img
        src="/logos/logo-full-white.svg"
        alt="Unitfield"
        className={cn("h-8 w-auto hidden dark:block", className)}
        {...rest}
      />
    </>
  );
}
