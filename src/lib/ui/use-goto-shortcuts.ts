"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { resolveGoto } from "@/lib/ui/commands";
import type { Role } from "@/lib/ui/permissions";

/**
 * Two-stroke navigation: press `g`, then a destination key (`g` `p` → Projects).
 *
 * Chosen over single-letter shortcuts because a bare `p` would collide with
 * ordinary typing the moment focus leaves an input. The `g` prefix makes intent
 * explicit and matches the convention users already know from other tools.
 *
 * Guards:
 * - Ignores keystrokes while focus is in an input, textarea, select or
 *   contenteditable, so typing is never stolen.
 * - Ignores anything with a modifier held, leaving browser shortcuts intact.
 * - The pending `g` expires after 1.2s so a stray press cannot lie in wait and
 *   hijack the next keystroke.
 * - Destinations the role cannot access resolve to null and do nothing.
 *
 * Returns whether a `g` is currently pending, so the shell can show a hint.
 */
export function useGotoShortcuts(role: Role) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function disarm() {
      armed = false;
      setPending(false);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }

    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        disarm();
        return;
      }

      const key = event.key.toLowerCase();

      if (!armed) {
        if (key === "g") {
          armed = true;
          setPending(true);
          timer = setTimeout(disarm, 1200);
        }
        return;
      }

      // Second stroke: resolve it, then always disarm regardless of outcome.
      const href = resolveGoto(role, key);
      disarm();

      if (href) {
        event.preventDefault();
        router.push(href);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [role, router]);

  return pending;
}
