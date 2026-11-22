import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Where in the shell header a page may put its own content: after the title, or before the icons. */
export type HeaderSlotName = 'start' | 'end';

const elements: Record<HeaderSlotName, HTMLElement | null> = { start: null, end: null };
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const register = (name: HeaderSlotName) => (element: HTMLElement | null) => {
  elements[name] = element;
  listeners.forEach((listener) => listener());
};
const outletRefs: Record<HeaderSlotName, (element: HTMLElement | null) => void> = {
  start: register('start'),
  end: register('end'),
};

/** The header's side of a slot. It stays empty, and takes no room, unless a page fills it. */
export function HeaderSlotOutlet({ name }: { name: HeaderSlotName }) {
  return <div className={`navbar-slot navbar-slot-${name}`} ref={outletRefs[name]} />;
}

/** Renders its children into the shell header for as long as the page showing them is mounted. */
export function HeaderSlot({ name, children }: { name: HeaderSlotName; children: ReactNode }) {
  const target = useSyncExternalStore(
    subscribe,
    () => elements[name],
    () => null
  );
  return target ? createPortal(children, target) : null;
}
