"use client";

import * as React from "react";

/** Calls back only after a value changes, with the value from the previous render. */
export function useOnChange<T>(value: T, onChange: (current: T, previous: T) => void) {
  const previous = React.useRef(value);

  React.useEffect(() => {
    if (Object.is(previous.current, value)) return;
    const before = previous.current;
    previous.current = value;
    onChange(value, before);
  }, [onChange, value]);
}
