import { useEffect, useRef } from "react";

// The first reply is what was already there, so only what turns up after it is
// announced.
export function useArrivals<T>(
  items: T[] | null,
  keyOf: (item: T) => string | number,
  announce: (item: T) => void,
) {
  const seen = useRef<Set<string | number> | null>(null);

  useEffect(() => {
    if (items === null) return;

    if (seen.current === null) {
      seen.current = new Set(items.map(keyOf));
      return;
    }

    for (const item of items) {
      const key = keyOf(item);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      announce(item);
    }
  }, [items]);
}
