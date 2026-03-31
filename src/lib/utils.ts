import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export const logger = {
  log: (...args: unknown[]) => console.log(`[${ts()}]`, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}]`, ...args),
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "PENDING":
      return "text-yellow-500";
    case "APPROVED":
      return "text-blue-500";
    case "DOWNLOADING":
      return "text-cyan-500";
    case "DECLINED":
      return "text-red-500";
    case "AVAILABLE":
      return "text-green-500";
    case "CANCELLED":
      return "text-gray-500";
    default:
      return "text-muted-foreground";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getStatusBadgeVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "PENDING":
      return "secondary";
    case "APPROVED":
      return "default";
    case "DOWNLOADING":
      return "secondary";
    case "DECLINED":
      return "destructive";
    case "AVAILABLE":
      return "default";
    case "CANCELLED":
      return "outline";
    default:
      return "outline";
  }
}
