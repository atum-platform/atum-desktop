import { RefreshCwIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { clsx as cn } from "clsx";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const refreshIconVariants = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
});

export function RefreshIcon({
  refreshing = false,
  className,
  size,
  ...props
}: React.ComponentPropsWithoutRef<typeof RefreshCwIcon> &
  VariantProps<typeof refreshIconVariants> & { refreshing?: boolean }) {
  return (
    <RefreshCwIcon
      aria-hidden
      className={cn(
        refreshIconVariants({ size }),
        refreshing && "motion-safe:animate-spin",
        className,
      )}
      {...props}
    />
  );
}
