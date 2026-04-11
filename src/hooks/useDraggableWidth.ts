'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  min: number;
  max: number;
}

export function useDraggableWidth(
  storageKey: string,
  defaultWidth: number,
  { min, max }: Options,
) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= min && n <= max) return n;
    }
    return defaultWidth;
  });

  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(defaultWidth);
  const handleRef = useRef<HTMLDivElement | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(max, Math.max(min, startWidth.current + delta));
      setWidth(next);
    },
    [min, max],
  );

  const onMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setWidth((w) => {
      localStorage.setItem(storageKey, String(w));
      return w;
    });
  }, [storageKey]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    handle.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      handle.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [width, onMouseMove, onMouseUp]);

  return { width, handleRef };
}
