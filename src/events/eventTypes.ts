/** Centralized event type constants. Single source of truth for engine-internal events. */
export const EVENT_TYPES = {
    MOUSE_MOVE: 'mousemove',
    MOUSE_DOWN: 'mousedown',
    MOUSE_UP: 'mouseup',
    WHEEL: 'wheel',
    COLLISION: 'collision',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];
