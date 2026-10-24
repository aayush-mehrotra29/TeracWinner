"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { TextShimmer } from "@/components/ui/chain-of-thought-utils/text-shimmer";
import { useOnChange } from "@/components/ui/chain-of-thought-utils/use-on-change";
import { cn } from "@/lib/utils";

export type ChainOfThoughtStepStatus = "pending" | "active" | "completed" | "error";

type RootContextValue = {
  registerStep: (id: string, status: ChainOfThoughtStepStatus) => void;
  unregisterStep: (id: string) => void;
  allStepsComplete: boolean;
  hasAnyError: boolean;
};

const RootContext = React.createContext<RootContextValue | null>(null);

function useRootContext(component: string) {
  const context = React.useContext(RootContext);
  if (!context) throw new Error(`${component} must be used within <ChainOfThought>`);
  return context;
}

type StepContextValue = { status: ChainOfThoughtStepStatus; hasContent: boolean };
const StepContext = React.createContext<StepContextValue | null>(null);

function useStepContext(component: string) {
  const context = React.useContext(StepContext);
  if (!context) throw new Error(`${component} must be used within <ChainOfThoughtStep>`);
  return context;
}

// Keep the primitive self-contained: the workspace does not define shadcn color
// tokens or collapsible animation utilities. Reduced-motion users see static text.
const componentStyles = `
  @keyframes cot-shimmer { from { background-position: 130% 50%; } to { background-position: -130% 50%; } }
  @keyframes cot-expand { from { height: 0; } to { height: var(--radix-collapsible-content-height); } }
  @keyframes cot-collapse { from { height: var(--radix-collapsible-content-height); } to { height: 0; } }
  .cot-text-shimmer { animation: cot-shimmer 2.4s linear infinite; }
  [data-slot="chain-of-thought-content"][data-state="open"],
  [data-slot="chain-of-thought-step-content"][data-state="open"] { animation: cot-expand 180ms ease-out; }
  [data-slot="chain-of-thought-content"][data-state="closed"] { display: none; }
  [data-slot="chain-of-thought-step-content"][data-state="closed"] { animation: cot-collapse 160ms ease-in; }
  @media (prefers-reduced-motion: reduce) {
    .cot-text-shimmer { animation: none !important; background-image: none !important; color: inherit !important; }
    [data-slot="chain-of-thought-content"], [data-slot="chain-of-thought-step-content"] { animation: none !important; }
  }
`;

type ChainOfThoughtProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "defaultOpen" | "onOpenChange"
> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  autoCloseOnAllComplete?: boolean;
};

function ChainOfThought({
  className,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  autoCloseOnAllComplete = true,
  children,
  ...props
}: ChainOfThoughtProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [stepStatuses, setStepStatuses] = React.useState<Record<string, ChainOfThoughtStepStatus>>({});
  const statuses = Object.values(stepStatuses);
  const allStepsComplete = statuses.length > 0 && statuses.every((status) => status === "completed");
  const hasAnyError = statuses.some((status) => status === "error");

  const registerStep = React.useCallback((id: string, status: ChainOfThoughtStepStatus) => {
    setStepStatuses((previous) => previous[id] === status ? previous : { ...previous, [id]: status });
  }, []);
  const unregisterStep = React.useCallback((id: string) => {
    setStepStatuses((previous) => {
      if (!(id in previous)) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [isControlled, onOpenChange]);

  useOnChange(allStepsComplete, (current, previous) => {
    if (autoCloseOnAllComplete && !isControlled && !previous && current) {
      setInternalOpen(false);
      onOpenChange?.(false);
    }
  });

  const contextValue = React.useMemo(
    () => ({ registerStep, unregisterStep, allStepsComplete, hasAnyError }),
    [registerStep, unregisterStep, allStepsComplete, hasAnyError],
  );

  return (
    <RootContext.Provider value={contextValue}>
      <Collapsible
        data-slot="chain-of-thought"
        className={cn("not-prose w-full", className)}
        open={isControlled ? openProp : internalOpen}
        onOpenChange={handleOpenChange}
        {...props}
      >
        <style>{componentStyles}</style>
        {children}
      </Collapsible>
    </RootContext.Provider>
  );
}

type ChainOfThoughtTriggerProps = React.ComponentProps<typeof CollapsibleTrigger> & {
  label?: React.ReactNode;
  icon?: React.ReactNode;
  /** Overrides the derived loading state without changing the step statuses. */
  active?: boolean;
};

function ChainOfThoughtTrigger({
  className,
  icon,
  label,
  active,
  children,
  ...props
}: ChainOfThoughtTriggerProps) {
  const { allStepsComplete, hasAnyError } = useRootContext("ChainOfThoughtTrigger");
  const isActive = active ?? (!allStepsComplete && !hasAnyError);

  return (
    <CollapsibleTrigger
      data-slot="chain-of-thought-trigger"
      data-active={String(isActive)}
      aria-busy={isActive}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-1.5 overflow-hidden text-neutral-500 transition-colors hover:text-neutral-900",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-start gap-1.5 overflow-hidden">
        <TextShimmer
          className="truncate text-left text-sm leading-[1.125rem] whitespace-nowrap"
          spread={10}
          invertLight
          disableShimmer={!isActive}
        >
          {children ?? label}
        </TextShimmer>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={2}
          className="ml-0.5 size-4 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-data-[state=open]:rotate-180 group-data-[state=open]:opacity-100"
        />
      </span>
    </CollapsibleTrigger>
  );
}

type ChainOfThoughtContentProps = React.ComponentProps<typeof CollapsibleContent>;

function ChainOfThoughtContent({ className, children, forceMount = true, ...props }: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent
      data-slot="chain-of-thought-content"
      className={cn("mt-3 space-y-3 overflow-hidden", className)}
      forceMount={forceMount}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

function hasTitleIcon(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) =>
    React.isValidElement<{ icon?: React.ReactNode }>(child) && child.props.icon != null,
  );
}

function hasStepContent(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) =>
    React.isValidElement(child) && child.type === ChainOfThoughtStepContent,
  );
}

type ChainOfThoughtStepProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "defaultOpen" | "onOpenChange"
> & {
  status?: ChainOfThoughtStepStatus;
  hasContent?: boolean;
  showConnector?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  autoCloseOnComplete?: boolean;
};

function ChainOfThoughtStep({
  className,
  status = "pending",
  hasContent,
  showConnector,
  open: openProp,
  defaultOpen,
  onOpenChange,
  autoCloseOnComplete = true,
  children,
  ...props
}: ChainOfThoughtStepProps) {
  const { registerStep, unregisterStep } = useRootContext("ChainOfThoughtStep");
  const stepId = React.useId();
  const resolvedHasContent = hasContent ?? hasStepContent(children);
  const showConnectorResolved = showConnector ?? hasTitleIcon(children);
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(
    () => defaultOpen ?? (resolvedHasContent && (status === "active" || status === "error")),
  );

  React.useEffect(() => {
    registerStep(stepId, status);
  }, [registerStep, stepId, status]);

  React.useEffect(() => () => unregisterStep(stepId), [stepId, unregisterStep]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [isControlled, onOpenChange]);

  useOnChange(status, (current, previous) => {
    if (!isControlled && resolvedHasContent && (current === "active" || current === "error")) {
      setInternalOpen(true);
      onOpenChange?.(true);
      return;
    }
    if (!isControlled && resolvedHasContent && current === "completed" && previous !== "completed" && autoCloseOnComplete) {
      setInternalOpen(false);
      onOpenChange?.(false);
    }
  });

  useOnChange(resolvedHasContent, (current) => {
    if (!isControlled && current && (status === "active" || status === "error")) {
      setInternalOpen(true);
      onOpenChange?.(true);
    }
  });

  return (
    <StepContext.Provider value={{ status, hasContent: resolvedHasContent }}>
      <Collapsible
        data-slot="chain-of-thought-step"
        data-status={status}
        className={cn("relative w-full", className)}
        open={isControlled ? openProp : internalOpen}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
        {showConnectorResolved && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-5 -bottom-3 left-2 w-px",
              status === "error" ? "bg-red-200" : "bg-neutral-200",
            )}
          />
        )}
      </Collapsible>
    </StepContext.Provider>
  );
}

type StepTitleSharedProps = {
  label?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  collapsible?: boolean;
  /** Controls the loading shimmer independently from the step status. */
  active?: boolean;
};

type StepTitleCollapsibleProps = StepTitleSharedProps &
  Omit<React.ComponentProps<typeof CollapsibleTrigger>, "children"> & { collapsible: true };
type StepTitleStaticProps = StepTitleSharedProps &
  React.HTMLAttributes<HTMLDivElement> & { collapsible?: false };
type ChainOfThoughtStepTitleProps = StepTitleCollapsibleProps | StepTitleStaticProps;

function ChainOfThoughtStepTitle({
  className,
  label: labelProp,
  icon,
  collapsible,
  active,
  children,
  ...props
}: ChainOfThoughtStepTitleProps) {
  const { hasContent, status } = useStepContext("ChainOfThoughtStepTitle");
  const isCollapsible = collapsible ?? hasContent;
  const isActive = status === "active";
  const shimmerActive = active ?? isActive;
  const isError = status === "error";
  const resolvedIcon = isError && icon
    ? <AlertTriangle strokeWidth={1.75} className="size-4" aria-hidden="true" />
    : icon;
  const label = children ?? labelProp;
  const titleClass = cn(
    "group flex items-center text-sm leading-[1.125rem] text-neutral-500",
    isError && "text-red-600",
    resolvedIcon ? "gap-2" : "gap-0",
    className,
  );
  const titleContent = <>
    {resolvedIcon && <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden="true">{resolvedIcon}</span>}
    <span className="flex min-w-0 flex-1 items-start gap-1.5 overflow-hidden">
      <TextShimmer
        className="truncate text-left text-sm leading-[1.125rem] whitespace-nowrap"
        spread={10}
        invertLight
        disableShimmer={!shimmerActive}
      >
        {label}
      </TextShimmer>
      {isCollapsible && <ChevronDown
        aria-hidden="true"
        strokeWidth={2}
        className="ml-0.5 size-4 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-data-[state=open]:rotate-180 group-data-[state=open]:opacity-100"
      />}
    </span>
  </>;

  if (!isCollapsible) {
    return (
      <div
        data-slot="chain-of-thought-step-title"
        data-active={String(isActive)}
        className={titleClass}
        {...(props as React.HTMLAttributes<HTMLDivElement>)}
      >
        {titleContent}
      </div>
    );
  }

  return (
    <CollapsibleTrigger
      data-slot="chain-of-thought-step-title"
      data-active={String(isActive)}
      aria-busy={shimmerActive}
      className={cn("w-full cursor-pointer text-left transition-colors hover:text-neutral-900", isError && "hover:text-red-700", titleClass)}
      {...(props as Omit<React.ComponentProps<typeof CollapsibleTrigger>, "children">)}
    >
      {titleContent}
    </CollapsibleTrigger>
  );
}

type ChainOfThoughtStepContentProps = React.ComponentProps<typeof CollapsibleContent>;

function ChainOfThoughtStepContent({ className, children, ...props }: ChainOfThoughtStepContentProps) {
  return (
    <CollapsibleContent
      data-slot="chain-of-thought-step-content"
      className={cn("mt-2 ml-6 overflow-hidden", className)}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

type ChainOfThoughtCompleteProps = React.HTMLAttributes<HTMLDivElement> & {
  icon?: React.ReactNode;
  label: React.ReactNode;
};

function ChainOfThoughtComplete({ className, icon, label, ...props }: ChainOfThoughtCompleteProps) {
  return (
    <div
      data-slot="chain-of-thought-complete"
      className={cn("mt-0 flex items-center gap-2 text-sm leading-[1.125rem] text-neutral-500", !icon && "gap-0", className)}
      {...props}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}

export {
  ChainOfThought,
  ChainOfThoughtTrigger,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtStepTitle,
  ChainOfThoughtStepContent,
  ChainOfThoughtComplete,
};

export default ChainOfThought;
