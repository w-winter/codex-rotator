"use client";

import { type ReactNode, useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "@iconify/react";

import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type AccordionCardTriggerMode = "header" | "manual";
export type AccordionCardIndicatorMode = "chevron" | "none";

interface UseAccordionCardStateOptions {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface AccordionCardState {
  open: boolean;
  setOpen: (nextOpen: boolean) => void;
  toggle: () => void;
  openCard: () => void;
  closeCard: () => void;
}

interface AccordionCardProps extends UseAccordionCardStateOptions {
  state?: AccordionCardState;
  triggerMode?: AccordionCardTriggerMode;
  indicatorMode?: AccordionCardIndicatorMode;
  header: ReactNode;
  collapsedContent?: ReactNode;
  expandedContent?: ReactNode;
  className?: string;
  cardClassName?: string;
  triggerClassName?: string;
  footerClassName?: string;
  collapsedContainerClassName?: string;
  expandedContainerClassName?: string;
}

const listItemTransition = {
  layout: { type: "spring" as const, stiffness: 300, damping: 30 },
  opacity: { duration: 0.2 },
  y: { type: "spring" as const, stiffness: 400, damping: 25 },
};

const contentTransition = { duration: 0.2, ease: "easeInOut" as const };

export function useAccordionCardState({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: UseAccordionCardStateOptions = {}): AccordionCardState {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }

      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const openCard = useCallback(() => setOpen(true), [setOpen]);
  const closeCard = useCallback(() => setOpen(false), [setOpen]);

  return useMemo(
    () => ({ open, setOpen, toggle, openCard, closeCard }),
    [closeCard, open, openCard, setOpen, toggle],
  );
}

export function AccordionCard({
  open,
  defaultOpen,
  onOpenChange,
  state,
  triggerMode = "header",
  indicatorMode,
  header,
  collapsedContent,
  expandedContent,
  className,
  cardClassName,
  triggerClassName,
  footerClassName,
  collapsedContainerClassName,
  expandedContainerClassName,
}: AccordionCardProps) {
  const internalState = useAccordionCardState({ open, defaultOpen, onOpenChange });
  const accordionState = state ?? internalState;
  const resolvedIndicatorMode =
    indicatorMode ?? (triggerMode === "header" ? "chevron" : "none");

  const triggerContent = (
    <>
      <div className="min-w-0 flex-1">{header}</div>
      {resolvedIndicatorMode === "chevron" ? (
        <motion.div
          animate={{ rotate: accordionState.open ? 180 : 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
          <Icon
            icon="fluent:chevron-down-20-regular"
            className="h-5 w-5 text-muted-foreground"
          />
        </motion.div>
      ) : null}
    </>
  );

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={listItemTransition}
      className={className}
    >
      <Card className={cn("border-border/60", cardClassName)} noPadding>
        <CardContent className="p-0">
          {triggerMode === "header" ? (
            <motion.button
              type="button"
              onClick={accordionState.toggle}
              className={cn(
                "group flex w-full cursor-pointer items-center justify-between gap-3 text-left transition-colors hover:bg-secondary",
                triggerClassName,
              )}
              whileHover={{ backgroundColor: "hsl(var(--secondary))" }}
              transition={{ duration: 0.15 }}
            >
              {triggerContent}
            </motion.button>
          ) : (
            <div
              className={cn(
                "flex w-full items-center justify-between gap-3 text-left",
                triggerClassName,
              )}
            >
              {triggerContent}
            </div>
          )}
        </CardContent>

        <CardFooter
          className={cn(
            "flex-col items-stretch overflow-hidden px-3",
            accordionState.open ? "gap-4 pb-3 pt-3" : "",
            footerClassName,
          )}
        >
          <AnimatePresence mode="wait">
            {!accordionState.open && collapsedContent ? (
              <motion.div
                key="collapsed"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={contentTransition}
                className={cn("w-full", collapsedContainerClassName)}
              >
                {collapsedContent}
              </motion.div>
            ) : null}

            {accordionState.open && expandedContent ? (
              <motion.div
                key="expanded"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                className={cn("w-full", expandedContainerClassName)}
              >
                {expandedContent}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </CardFooter>
      </Card>
    </motion.div>
  );
}
