import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Spinner } from "./spinner";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-juke-orange text-white hover:bg-juke-orange-hover",
  secondary: "bg-juke-purple text-white hover:bg-juke-purple-hover",
  ghost:
    "bg-transparent text-juke-text-on-dark hover:bg-white/10 border border-juke-border",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
};

const BASE_CLASSES =
  "inline-flex items-center justify-center rounded-full font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap";

function composeClasses(
  variant: ButtonVariant,
  size: ButtonSize,
  fullWidth: boolean,
  className?: string,
): string {
  return cn(
    BASE_CLASSES,
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  leftIcon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  leftIcon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={composeClasses(variant, size, fullWidth, className)}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" />
      ) : (
        leftIcon
      )}
      {children}
    </button>
  );
}

export interface LinkButtonProps
  extends ComponentPropsWithoutRef<typeof Link> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
}

/** Anchor-styled twin of {@link Button} for navigation (uses next/link). */
export function LinkButton({
  variant = "primary",
  size = "md",
  fullWidth = false,
  leftIcon,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      className={composeClasses(variant, size, fullWidth, className)}
      {...rest}
    >
      {leftIcon}
      {children}
    </Link>
  );
}
