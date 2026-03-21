import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

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
    default:
      return "text-muted-foreground";
  }
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
    default:
      return "outline";
  }
}
