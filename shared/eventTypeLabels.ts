/**
 * M6.2.D — Event Type Labels & Utilities
 *
 * Shared between frontend and backend for consistent labeling.
 */

export const EVENT_TYPES = ["fair", "event", "gift", "internal", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeLabels: Record<EventType, string> = {
  fair: "Fiera",
  event: "Evento",
  gift: "Omaggio",
  internal: "Uso Interno",
  other: "Altro",
};

export const eventTypeColors: Record<EventType, string> = {
  fair: "bg-purple-100 text-purple-800",
  event: "bg-blue-100 text-blue-800",
  gift: "bg-pink-100 text-pink-800",
  internal: "bg-gray-100 text-gray-800",
  other: "bg-orange-100 text-orange-800",
};

export function getEventTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return eventTypeLabels[type as EventType] ?? type;
}

export function getEventTypeColor(type: string | null | undefined): string {
  if (!type) return "bg-gray-100 text-gray-800";
  return eventTypeColors[type as EventType] ?? "bg-gray-100 text-gray-800";
}
