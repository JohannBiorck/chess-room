import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <Icon>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M15 4H6a2 2 0 0 0-2 2v9" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path
        d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m1 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
        transform="translate(2 1) scale(.9)"
      />
    </Icon>
  );
}

export function FlipIcon() {
  return (
    <Icon>
      <path d="M3 8h16m-4-4 4 4-4 4M21 16H5m4-4-4 4 4 4" />
    </Icon>
  );
}

export function ShieldIcon() {
  return (
    <Icon>
      <path d="m12 3 8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </Icon>
  );
}
