import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button
      variant="input"
      size="iconMd"
      className="h-8 w-8"
      onClick={toggleTheme}
      type="button"
    >
      <Icon icon={theme === "dark" ? "lucide:moon" : "lucide:sun"} className="h-4 w-4" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
